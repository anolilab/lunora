import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { runSql } from "../src/do-exec";
import { renderSql, sqliteInList, unionAll, WORKERD_SQLITE_LIMITS } from "../src/drizzle";
import { buildSeekBeforeWhere, buildSeekWhere } from "../src/query-args";
import { compileWhereSql } from "../src/where-sql";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The SQL this engine emits has to fit limits Workerd sets far below stock
 * SQLite's — `SQLITE_LIMIT_COMPOUND_SELECT` 5 (vs 500),
 * `SQLITE_LIMIT_VARIABLE_NUMBER` 100 (vs 500,000), and
 * `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` 50 (vs 50,000). D1 runs the same build. Go
 * over one and the statement fails at runtime with `SQLITE_ERROR`, which is how
 * a bare-id `delete` on a six-table schema came to throw "too many terms in
 * compound SELECT" in production.
 *
 * `node:sqlite` runs with the stock limits and exposes no way to lower them, so
 * each cap is asserted on the *rendered* SQL — placeholder count, compound
 * width, absence of a LIKE pattern — while the behavioural cases alongside prove
 * the reshaped statement still returns the same rows on a real SQLite build.
 */

/** The widest compound (count of `UNION ALL`-joined terms) at any single paren depth in `text`. */
const widestCompound = (text: string): number => {
    const termsAtDepth = new Map<number, number>();
    let depth = 0;
    let widest = 1;

    for (const token of text.split(/\s+/u)) {
        for (const character of token) {
            if (character === "(") {
                depth += 1;
                termsAtDepth.set(depth, 1);
            } else if (character === ")") {
                depth -= 1;
            }
        }

        if (token === "UNION") {
            const terms = (termsAtDepth.get(depth) ?? 1) + 1;

            termsAtDepth.set(depth, terms);
            widest = Math.max(widest, terms);
        }
    }

    return widest;
};

const schemaWith = (tableCount: number, rls = false): SchemaLike => {
    return {
        ...(rls ? { rlsMode: "required" } : {}),
        tables: Object.fromEntries(
            Array.from({ length: tableCount }, (_, index) => [`t${String(index)}`, { indexes: [], isPublic: rls, shape: { title: { kind: "string" } } }]),
        ),
    };
};

describe("compound SELECT term cap", () => {
    it("counts compound terms per nesting depth", () => {
        expect.assertions(3);

        expect(widestCompound("SELECT 1")).toBe(1);
        expect(widestCompound("SELECT 1 UNION ALL SELECT 2")).toBe(2);
        expect(widestCompound("SELECT * FROM (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3) x UNION ALL SELECT 4")).toBe(3);
    });

    it.each([1, 2, 5, 6, 13, 26, 126])("nests %i branches so no compound exceeds five terms", (branchCount) => {
        expect.assertions(1);

        const branches = Array.from({ length: branchCount }, (_, index) => dsql`SELECT ${index} AS ${dsql.identifier("x")}`);

        expect(widestCompound(renderSql("sqlite", unionAll(branches)).sql)).toBeLessThanOrEqual(5);
    });

    it("rejects an empty branch list", () => {
        expect.assertions(1);

        expect(() => unionAll([])).toThrow("at least one branch");
    });

    it("returns the same rows from a nested probe as a flat one would, on a schema wider than the cap", async () => {
        expect.assertions(3);

        const harness = createSqliteExec();

        try {
            // Eight tables: past Workerd's five-term cap, so the probe must nest.
            const schema = schemaWith(8);

            runShardMigrations(harness.sql, schema);

            const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

            const id = await writer.insert("t6", { title: "before" });
            const other = await writer.insert("t1", { title: "untouched" });

            // Bare-id (no `expectedTable`) — the unscoped probe the issue reports.
            await writer.patch(id, { title: "after" });

            await expect(writer.get(id)).resolves.toMatchObject({ title: "after" });

            await writer.delete(id);

            await expect(writer.get(id)).resolves.toBeNull();
            await expect(writer.get(other)).resolves.toMatchObject({ title: "untouched" });
        } finally {
            harness.close();
        }
    });

    it("resolves every id through the reshaped guarded batch probe, on a schema wider than the cap", async () => {
        expect.assertions(1);

        const harness = createSqliteExec();

        try {
            // The batched probe is the RLS guard's `deleteMany` pre-check, so it
            // only runs under a `.rls("required")` schema with `enforceRls`.
            const schema = schemaWith(8, true);

            runShardMigrations(harness.sql, schema);

            const admin = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
            // More ids than the 100-bound-variable budget allows in one
            // statement at eight branches apiece, so the id list has to stop
            // being one placeholder per id.
            const ids: string[] = [];

            for (let index = 0; index < 40; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential inserts against a single-threaded SQLite harness
                ids.push(await admin.insert(`t${String(index % 8)}`, { title: `row ${String(index)}` }));
            }

            const guarded = createShardContextDatabase({ clock: () => 1_700_000_000_000, enforceRls: true, schema, sql: harness.sql });

            await guarded.deleteMany!(ids);

            const survivors = [];

            for (const id of ids) {
                // eslint-disable-next-line no-await-in-loop -- sequential reads against a single-threaded SQLite harness
                survivors.push(await admin.get(id));
            }

            expect(survivors.filter(Boolean)).toEqual([]);
        } finally {
            harness.close();
        }
    });
});

describe("bound-parameter cap", () => {
    // eslint-disable-next-line no-restricted-syntax -- a drizzle identifier chunk, not a string conversion; the rule misfires on the inner TemplateLiteral
    const fieldRef = (field: string): SQL => dsql`${dsql.identifier(field)}`;
    const strategy = { fieldRef, inList: sqliteInList, serialize: (value: unknown) => value };

    it.each([
        ["in", false],
        ["notIn", true],
    ])("spends one parameter, not one per item, on a wide `%s`", (operator, negated) => {
        expect.assertions(2);

        const items = Array.from({ length: 400 }, (_, index) => `id-${String(index)}`);
        const compiled = compileWhereSql({ id: { [operator]: items } }, strategy);
        const { params, sql: text } = renderSql("sqlite", compiled!);

        expect(params).toStrictEqual([JSON.stringify(items)]);
        expect(text).toBe(`"id"${negated ? " NOT IN " : " IN "}(SELECT "value" FROM json_each(?))`);
    });

    it("keeps a short list literal, so an index still plans against it", () => {
        expect.assertions(1);

        const compiled = compileWhereSql({ id: { in: ["a", "b", "c"] } }, strategy);

        expect(renderSql("sqlite", compiled!)).toStrictEqual({ params: ["a", "b", "c"], sql: `"id" IN (?, ?, ?)` });
    });

    it.each([
        ["a non-finite number", Number.NaN],
        ["a lone surrogate", "\uD800x"],
        ["bytes", new Uint8Array([1, 2, 3])],
    ])("keeps a list holding %s literal, because JSON would not carry it back unchanged", (_label, odd) => {
        expect.assertions(2);

        // `JSON.stringify` turns each of these into something else — NaN into
        // `null`, a lone surrogate into U+FFFD — so the JSON form would match
        // different rows than the literal one. Under budget they stay literal.
        const items = [1, 2, odd];
        const { params, sql: text } = renderSql("sqlite", compileWhereSql({ score: { in: items } }, strategy)!);

        expect(params).toStrictEqual(items);
        expect(text).not.toContain("json_each");
    });

    it("refuses an over-budget list it can neither bind as one parameter nor fit as placeholders", () => {
        expect.assertions(1);

        // Over budget AND not JSON-safe: there is no form of this statement that
        // prepares on Workerd, so it fails with a message that says so rather
        // than with `SQLITE_ERROR: too many SQL variables` from the engine.
        const items = [...Array.from({ length: 400 }, (_, index) => index), Number.NaN];

        expect(() => compileWhereSql({ score: { in: items } }, strategy)).toThrow(/cannot be bound as one parameter/u);
    });

    it("chunks the by-id probes so a schema wider than the parameter cap stays under it", async () => {
        expect.assertions(4);

        const harness = createSqliteExec();

        try {
            // 120 tables: `unionAll` nests them past the compound-SELECT cap
            // fine, but one placeholder per branch — the id, or the `json_each`
            // list — still binds 120 parameters against Workerd's cap of 100.
            const schema = schemaWith(120, true);

            runShardMigrations(harness.sql, schema);

            const bound: number[] = [];
            const counting: SqlExec = {
                exec: (query, ...params) => {
                    bound.push(params.length);

                    return harness.sql.exec(query, ...params);
                },
            };

            const admin = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: counting });
            // The last table, so the owning branch lands in the second chunk.
            const id = await admin.insert("t119", { title: "before" });
            const guarded = createShardContextDatabase({ clock: () => 1_700_000_000_000, enforceRls: true, schema, sql: counting });

            bound.length = 0;

            // Bare-id (no `expectedTable`) — `locateRowById`'s unscoped probe.
            await admin.patch(id, { title: "after" });

            await expect(admin.get(id)).resolves.toMatchObject({ title: "after" });

            // And the RLS guard's batched `locateTablesByIds` pre-check.
            await guarded.deleteMany!([id]);

            await expect(admin.get(id)).resolves.toBeNull();
            expect(bound.length).toBeGreaterThan(0);
            expect(Math.max(...bound)).toBeLessThanOrEqual(100);
        } finally {
            harness.close();
        }
    });

    it("keeps a bounded page over the widest orderBy under the cap, seek included", () => {
        expect.assertions(3);

        // `@lunora/server`'s list args cap `orderBy` at 8 keys; `normalizeOrderKeys`
        // splices `_creationTime` in and `buildSeek` appends the `id` tiebreak, so
        // the widest reachable seek is 10 columns. A reactive page ANDs TWO of
        // them — the cursor's lower bound and the fixed end cursor's upper one.
        //
        // Flattened, that seek bound `k(k+1)/2` parameters each, so the pair spent
        // 110 against Workerd's cap of 100 and the statement failed to PREPARE
        // with a bare `SQLITE_ERROR` — a broken page, not a slow one. Nested, it
        // is `2k-1` each.
        const keys = [
            ...Array.from({ length: 8 }, (_, index) => {
                return { direction: "asc" as const, field: `f${String(index)}`, nullable: false };
            }),
            { direction: "asc" as const, field: "_creationTime", nullable: false },
        ];
        const values = [...keys.map((_, index) => index), "row_1"];

        const page = { AND: [buildSeekWhere(keys, values), buildSeekBeforeWhere(keys, values)] };
        const { params } = renderSql("sqlite", compileWhereSql(page, strategy)!);

        expect(params.length).toBeLessThanOrEqual(WORKERD_SQLITE_LIMITS.boundParams);
        // 10 columns: (2 * 10 - 1) for the nested seek + 1 for the redundant
        // leading bound, twice over.
        expect(params).toHaveLength(40);

        // And the list budget shrinks to match, rather than assuming a fixed half
        // of the cap is free: the two together must still fit.
        const items = Array.from({ length: 40 }, (_, index) => `id-${String(index)}`);
        const withList = renderSql("sqlite", compileWhereSql({ AND: [page, { tag: { in: items } }] }, strategy)!);

        expect(withList.params.length).toBeLessThanOrEqual(WORKERD_SQLITE_LIMITS.boundParams);
    });

    it("splits the list budget across every `in` in one `where`, not per list", () => {
        expect.assertions(2);

        // Three 40-item lists each sit under a 50-per-list threshold, so a
        // per-list budget renders all three literally — 120 placeholders in one
        // statement, over the cap. The budget is per statement, so each one
        // switches to its single JSON parameter instead.
        const items = Array.from({ length: 40 }, (_, index) => `id-${String(index)}`);
        const compiled = compileWhereSql({ AND: [{ a: { in: items } }, { b: { in: items } }, { c: { notIn: items } }] }, strategy);
        const { params, sql: text } = renderSql("sqlite", compiled!);

        expect(params).toHaveLength(3);
        expect(text.match(/json_each/gu)).toHaveLength(3);
    });

    it("chunks a bulk insert so no one statement passes the cap", async () => {
        expect.assertions(2);

        const harness = createSqliteExec();

        try {
            const schema = schemaWith(1);

            runShardMigrations(harness.sql, schema);

            const bound: number[] = [];
            const counting: SqlExec = {
                exec: (query, ...params) => {
                    if (query.startsWith("INSERT INTO")) {
                        bound.push(params.length);
                    }

                    return harness.sql.exec(query, ...params);
                },
            };

            const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: counting });
            // 200 rows at 3 bound parameters each — 600 placeholders if the
            // batch went out as one statement.
            const rows = Array.from({ length: 200 }, (_, index) => {
                return { title: `row ${String(index)}` };
            });

            await writer.insertMany!("t0", rows);

            expect(Math.max(...bound)).toBeLessThanOrEqual(100);

            const stored = await writer.findMany("t0", { limit: 500 });

            expect(stored.page).toHaveLength(200);
        } finally {
            harness.close();
        }
    });

    it("matches exactly the same rows either side of the threshold", async () => {
        expect.assertions(2);

        const harness = createSqliteExec();

        try {
            const schema = schemaWith(1);

            runShardMigrations(harness.sql, schema);

            const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
            const ids: string[] = [];

            for (let index = 0; index < 120; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential inserts against a single-threaded SQLite harness
                ids.push(await writer.insert("t0", { title: `row ${String(index)}` }));
            }

            // 120 wanted ids (past the threshold — the JSON form) plus a miss, so
            // an over-matching membership test would show up as an extra row.
            const wanted = [...ids, "absent-id"];
            const found = await writer.findMany("t0", { limit: 500, where: { id: { in: wanted } } });
            const excluded = await writer.findMany("t0", { limit: 500, where: { id: { notIn: wanted } } });

            expect(found.page).toHaveLength(120);
            expect(excluded.page).toHaveLength(0);
        } finally {
            harness.close();
        }
    });
});

/**
 * The longest run of `connector`-joined terms at any ONE paren depth in `text` —
 * the quantity that becomes expression-tree depth.
 *
 * Mirrors {@link widestCompound}, and for the same reason: total paren nesting
 * says nothing useful here, because a FLAT `(a) AND (b) AND (c)` chain nests
 * only one deep while being exactly the shape that blows the depth cap. What
 * matters is how many terms share a level.
 */
const widestChain = (text: string, connector: "AND" | "OR"): number => {
    const termsAtDepth = new Map<number, number>();
    let depth = 0;
    let widest = 1;

    for (const token of text.split(/\s+/u)) {
        for (const character of token) {
            if (character === "(") {
                depth += 1;
                termsAtDepth.set(depth, 1);
            } else if (character === ")") {
                depth -= 1;
            }
        }

        if (token === connector) {
            const terms = (termsAtDepth.get(depth) ?? 1) + 1;

            termsAtDepth.set(depth, terms);
            widest = Math.max(widest, terms);
        }
    }

    return widest;
};

describe("the statement backstop", () => {
    // Every builder sizes its own statement, so these fire only when one
    // regressed or a caller hand-wrote SQL — which is exactly when a message
    // naming the limit beats a bare SQLITE_ERROR from prepare.
    const neverRuns = {
        exec: () => {
            throw new Error("the backstop must reject before the statement reaches SQLite");
        },
    } as unknown as SqlExec;

    it("rejects a statement past the bound-parameter ceiling", () => {
        expect.assertions(1);

        expect(() => runSql(neverRuns, "SELECT 1", ...(Array.from({ length: 101 }).fill(0) as number[]))).toThrow(/101 parameters/u);
    });

    it("allows a statement exactly at the ceiling", () => {
        expect.assertions(1);

        // 100 is the limit, not one past it — the boundary the `>` turns on.
        expect(() => runSql(neverRuns, "SELECT 1", ...(Array.from({ length: 100 }).fill(0) as number[]))).toThrow(/must reject before/u);
    });

    it("rejects statement text past the length ceiling", () => {
        expect.assertions(1);

        expect(() => runSql(neverRuns, `SELECT ${"x".repeat(100_001)}`)).toThrow(/byte limit/u);
    });

    // The ceiling is bytes; `String.length` is UTF-16 units. A statement of
    // multi-byte text can sit under the character count and still breach.
    it("measures the ceiling in bytes, not characters", () => {
        expect.assertions(2);

        // 40,000 three-byte characters = 120,000 bytes, well over the limit,
        // while `length` reads 40,000 — a third of it.
        const multiByte = `SELECT '${"→".repeat(40_000)}'`;

        expect(multiByte.length).toBeLessThan(100_000);
        expect(() => runSql(neverRuns, multiByte)).toThrow(/byte limit/u);
    });
});

describe("expression-depth cap", () => {
    // eslint-disable-next-line no-restricted-syntax -- a drizzle identifier chunk, not a string conversion; the rule misfires on the inner TemplateLiteral
    const depthFieldRef = (field: string): SQL => dsql`${dsql.identifier(field)}`;
    const wideWhere = Object.fromEntries(Array.from({ length: 200 }, (_unused, index) => [`f${String(index)}`, index]));
    const compileWide = (): { params: unknown[]; sql: string } =>
        renderSql("sqlite", compileWhereSql(wideWhere, { fieldRef: depthFieldRef, inList: sqliteInList, serialize: (value: unknown) => value })!);

    it("measures terms per level, not total nesting", () => {
        expect.assertions(2);

        // The flat form this replaced — the one that blows the cap — nests only
        // one paren deep, so a nesting count would have called it healthy.
        expect(widestChain("(a) AND (b) AND (c)", "AND")).toBe(3);
        expect(widestChain("((a) AND (b)) AND ((c) AND (d))", "AND")).toBe(2);
    });

    it("never puts more than two terms at one level, however wide the where", () => {
        expect.assertions(1);

        // Halving pairs every level, so no level ever chains: this is the
        // assertion a flat `sql.join` fails at 200.
        expect(widestChain(compileWide().sql, "AND")).toBe(2);
    });

    it("keeps every clause, in order", () => {
        expect.assertions(1);

        expect(compileWide().params).toStrictEqual(Array.from({ length: 200 }, (_unused, index) => index));
    });

    it("still matches the same rows on a real SQLite build", async () => {
        expect.assertions(2);

        const harness = createSqliteExec();

        try {
            // DISTINCT fields, not N copies of one key: an object literal holds
            // each key once, so `Array.from({length: 200}, () => ["title", …])`
            // collapsed to a single condition and this case ran one term where
            // it claimed to run 200.
            //
            // 90, not 200, because the two caps meet here: one equality binds one
            // parameter, and the bound-parameter ceiling the suite above pins is
            // 100, so a genuinely-200-term `where` is rejected before it can be
            // executed at all. The structural assertions on `compileWide` still
            // cover the full 200.
            const fields = Array.from({ length: 90 }, (_unused, index) => `f${String(index)}`);
            const schema: SchemaLike = {
                tables: { t0: { indexes: [], shape: Object.fromEntries(fields.map((field) => [field, { kind: "string" }])) } },
            };

            runShardMigrations(harness.sql, schema);

            const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

            await writer.insert("t0", Object.fromEntries(fields.map((field) => [field, "kept"])));

            // Every one of them AND'd and satisfied, then one that is not.
            const satisfied = Object.fromEntries(fields.map((field) => [field, "kept"]));
            const rows = await writer.findMany("t0", { where: satisfied });

            expect(rows.page).toHaveLength(1);

            const contradicted = await writer.findMany("t0", { where: { ...satisfied, f0: "absent" } });

            expect(contradicted.page).toHaveLength(0);
        } finally {
            harness.close();
        }
    });
});

describe("`LIKE` pattern-length cap", () => {
    it("matches the same rows through a position test as `LIKE` did, and takes a wildcard literally", async () => {
        expect.assertions(2);

        const harness = createSqliteExec();

        try {
            const schema = schemaWith(1);

            runShardMigrations(harness.sql, schema);

            const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
            // 60 characters: a LIKE pattern built from this is 62 bytes, over
            // Workerd's 50-byte cap ("LIKE or GLOB pattern too complex").
            const term = "a".repeat(60);

            await writer.insert("t0", { title: `prefix ${term} suffix` });
            await writer.insert("t0", { title: "unrelated" });

            const rows = await writer.findMany("t0", { where: { title: { contains: term } } });

            expect(rows.page).toHaveLength(1);

            // And a term full of wildcards matches literally rather than everything.
            const wildcard = await writer.findMany("t0", { where: { title: { contains: "%" } } });

            expect(wildcard.page).toHaveLength(0);
        } finally {
            harness.close();
        }
    });

    it("folds case the way SQLite's LIKE did, so existing matches still match", async () => {
        expect.assertions(1);

        const harness = createSqliteExec();

        try {
            const schema = schemaWith(1);

            runShardMigrations(harness.sql, schema);

            const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

            await writer.insert("t0", { title: "Hello World" });

            const rows = await writer.findMany("t0", { where: { title: { contains: "LO WOR" } } });

            expect(rows.page).toHaveLength(1);
        } finally {
            harness.close();
        }
    });
});
