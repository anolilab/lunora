import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { renderSql, sqliteInList, unionAll } from "../src/drizzle";
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

    it("resolves a bare-id patch and delete on a schema wider than the cap", async () => {
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

    it("resolves many ids through the guarded batch probe on a schema wider than the cap", async () => {
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

    it("keeps a non-finite number literal, because `JSON.stringify` writes it as null", () => {
        expect.assertions(2);

        // Long enough for the JSON form, but `[NaN]` stringifies to `[null]` —
        // so the JSON list would stop matching NaN and start matching null.
        const items = [...Array.from({ length: 400 }, (_, index) => index), Number.NaN, Number.POSITIVE_INFINITY];
        const compiled = compileWhereSql({ score: { in: items } }, strategy);
        const { params, sql: text } = renderSql("sqlite", compiled!);

        expect(params).toStrictEqual(items);
        expect(text).not.toContain("json_each");
    });

    it("chunks the by-id probes so a schema wider than the parameter cap stays under it", async () => {
        expect.assertions(3);

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
            expect(Math.max(...bound)).toBeLessThanOrEqual(100);
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

describe("lIKE pattern-length cap", () => {
    it("compiles `contains` to a position test, so a long term is not a pattern", async () => {
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
