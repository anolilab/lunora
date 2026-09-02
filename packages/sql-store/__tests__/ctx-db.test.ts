import { DatabaseSync } from "node:sqlite";

import { LunoraError } from "@lunora/errors";
import { MAX_SEARCH_SCAN } from "@lunora/search-core";
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { CURSOR_PREFIX } from "@lunora/shard-engine";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb, readSqlCdcChanges } from "../src/ctx-db";
import type { SqlDialect } from "../src/dialect";

/**
 * In-package end-to-end coverage for the dialect-blind store core. The concrete
 * SqlDialect implementations live in `@lunora/d1` / `@lunora/hyperdrive`, so this
 * suite stands up a minimal SQLite dialect over Node's built-in `node:sqlite`
 * engine (D1 is SQLite — the generated SQL behaves identically) plus a tiny
 * recording exec for the cross-dialect rendering checks. No workerd required.
 */

/** Both workerd and `node:sqlite` phrase a UNIQUE-index breach as "UNIQUE constraint failed". */
const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;

const sqlAffinityForKind = (kind: string | undefined): string => {
    switch (kind) {
        case "bigint": {
            return "TEXT";
        }
        case "boolean": {
            return "INTEGER";
        }
        case "number": {
            return "REAL";
        }
        default: {
            return "TEXT";
        }
    }
};

/** A minimal reference SQLite dialect, mirroring `@lunora/d1`'s sqliteDialect (kept local so sql-store has no dependency on a downstream package). */

/**
 * Does this runtime's `node:sqlite` have the FTS5 module compiled in?
 *
 * It is a property of the RUNTIME, not of the dialect: Node 24 bundles a SQLite
 * with FTS5, Node 22 does not. Hard-coding `supportsFts5: true` made these
 * tests pass on one CI matrix leg and fail on the other with
 * `no such module: fts5`.
 *
 * Probing keeps both legs meaningful rather than skipping: where FTS5 exists
 * the suite exercises the `fts5` search layout, and where it does not it
 * exercises the portable `inverted` layout — which is exactly the split the
 * store already models for backends without FTS5.
 */
const RUNTIME_HAS_FTS5 = ((): boolean => {
    const probe = new DatabaseSync(":memory:");

    try {
        probe.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)");

        return true;
    } catch {
        return false;
    } finally {
        probe.close();
    }
})();

const makeSqliteDialect = (name: SqlDialect["name"] = "sqlite"): SqlDialect => {
    return {
        columnType: (kind) => sqlAffinityForKind(kind),
        companionTypes: {
            autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT",
            integer: "INTEGER",
            key: "TEXT",
            real: "REAL",
            text: "TEXT",
        },
        maxTableColumns: 100,
        frameworkColumns: () => [
            { name: "id", type: "TEXT PRIMARY KEY" },
            { name: "_creationTime", type: "REAL NOT NULL" },
        ],
        isUniqueViolation: (error) => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message),
        name,
        supportsFts5: RUNTIME_HAS_FTS5,
        supportsReturning: true,
        tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
    };
};

const createSqliteHarness = (): { close: () => void; exec: SqlCtxExec } => {
    const database = new DatabaseSync(":memory:");

    const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => database.prepare(query).all(...(parameters as never[]));

    return {
        close: () => {
            database.close();
        },
        exec: {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            run: (query, parameters) => {
                all(query, parameters);

                return Promise.resolve();
            },
        },
    };
};

/**
 * Wrap an exec so a bound value over `limitBytes` fails the way the real engine
 * does. `node:sqlite` is built with SQLite's default `SQLITE_MAX_LENGTH` (~1 GB),
 * so it stores a 2 MB row happily — the ceiling this asserts against is D1's, and
 * workerd raises it as a bare `SQLITE_TOOBIG` whose message is "string or blob
 * too big". Both seams are capped because an insert funnels through `run` while
 * a `RETURNING`-guarded patch funnels through `all`.
 */
const cappedExec = (exec: SqlCtxExec, limitBytes: number): SqlCtxExec => {
    const check = (parameters: ReadonlyArray<unknown>): void => {
        for (const parameter of parameters) {
            if (typeof parameter === "string" && Buffer.byteLength(parameter, "utf8") > limitBytes) {
                throw new Error("string or blob too big");
            }
        }
    };

    return {
        all: (query, parameters) => {
            check(parameters);

            return exec.all(query, parameters);
        },
        run: (query, parameters) => {
            check(parameters);

            return exec.run(query, parameters);
        },
    };
};

const col = (kind: string, extra: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...extra } }, kind };
};

/** An `optional(inner)` column — stays nullable in the DDL; `effectiveColumnKind` unwraps to `inner` for storage affinity/decode. */
const optionalCol = (innerKind: string): ValidatorLike =>
    ({ _meta: { column: { notNull: false }, inner: { _meta: { column: { notNull: false } }, kind: innerKind } }, kind: "optional" }) as never;

const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: {
                archived: col("boolean"),
                body: col("string"),
                priority: col("number"),
                slug: col("string", { unique: true }),
            },
            shardMode: { kind: "global" },
        },
    },
} as never;

describe("createSqlCtxDb — auto-provision + crud over node:sqlite", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    const makeWriter = () => createSqlCtxDb({ clock: () => 1_700_000_000_000, dialect: makeSqliteDialect(), exec: harness.exec, schema });

    it("auto-provisions the table and round-trips an inserted document", async () => {
        expect.assertions(3);

        const writer = makeWriter();
        const id = await writer.insert("notes", { archived: false, body: "hello", priority: 3, slug: "a" });

        expect(typeof id).toBe("string");

        const doc = await writer.get(id);

        expect(doc).toMatchObject({ archived: false, body: "hello", priority: 3, slug: "a" });
        expect(doc?._id).toBe(id);
    });

    it("names the row-size limit instead of redacting an oversized row to INTERNAL", async () => {
        expect.assertions(4);

        // D1's per-row ceiling is 2 MB; a row over it raises a bare
        // `SQLITE_TOOBIG`, which is not a LunoraError — so `toErrorBody` used to
        // redact it to `{ code: "INTERNAL", message: "Internal error" }`, status
        // 500, telling the caller nothing about a document they can simply move
        // to R2.
        const twoMegabytes = 2 * 1024 * 1024;
        const writer = createSqlCtxDb({
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec: cappedExec(harness.exec, twoMegabytes),
            schema,
        });

        const oversized = "x".repeat(twoMegabytes + 1);
        const error = await writer.insert("notes", { archived: false, body: oversized, priority: 1, slug: "big" }).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(LunoraError);
        expect((error as LunoraError).code).toBe("PAYLOAD_TOO_LARGE");
        expect((error as LunoraError).message).toContain('too large to store in "notes"');
        expect((error as LunoraError).message).toContain("2 MB on D1");
    });

    it("decodes booleans and numbers back to their JS forms", async () => {
        expect.assertions(2);

        const writer = makeWriter();
        const id = await writer.insert("notes", { archived: true, body: "x", priority: 7, slug: "b" });
        const doc = await writer.get(id);

        expect(doc?.archived).toBe(true);
        expect(doc?.priority).toBe(7);
    });

    it("patch updates only the provided fields", async () => {
        expect.assertions(1);

        const writer = makeWriter();
        const id = await writer.insert("notes", { archived: false, body: "x", priority: 1, slug: "c" });

        await writer.patch(id, { body: "patched" });

        const doc = await writer.get(id);

        expect(doc).toMatchObject({ archived: false, body: "patched", priority: 1, slug: "c" });
    });

    it("refuses an explicit undefined on patch and replace instead of NULLing the column", async () => {
        expect.assertions(3);

        // `runRowValidators` skips a present-but-undefined key
        // (`v.optional(x).parse(undefined)` is fine) and the serializer then wrote
        // `?? null`, so this silently cleared the column. The shard twin has
        // refused it since the footgun was found there; this side shares that
        // guard now rather than restating it.
        const writer = makeWriter();
        const id = await writer.insert("notes", { archived: false, body: "keep-me", priority: 1, slug: "u" });

        await expect(writer.patch(id, { body: undefined })).rejects.toThrow(/Cannot patch field 'body' to undefined/u);
        await expect(writer.replace(id, { archived: false, body: undefined, priority: 1, slug: "u" })).rejects.toThrow(
            /Cannot replace field 'body' to undefined/u,
        );

        // …and the stored value is untouched by the refused write.
        await expect(writer.get(id)).resolves.toMatchObject({ body: "keep-me" });
    });

    it("delete removes the row", async () => {
        expect.assertions(1);

        const writer = makeWriter();
        const id = await writer.insert("notes", { archived: false, body: "x", priority: 1, slug: "d" });

        await writer.delete(id);

        await expect(writer.get(id)).resolves.toBeNull();
    });

    it("maps a UNIQUE-constraint breach to a ConflictError", async () => {
        expect.assertions(1);

        const writer = makeWriter();

        await writer.insert("notes", { archived: false, body: "x", priority: 1, slug: "dup" });

        await expect(writer.insert("notes", { archived: false, body: "y", priority: 2, slug: "dup" })).rejects.toThrow(/unique constraint/iu);
    });

    it("findMany filters, orders, and paginates with a cursor", async () => {
        expect.assertions(3);

        const writer = makeWriter();

        for (const [index, slug] of ["s1", "s2", "s3"].entries()) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding for a deterministic order
            await writer.insert("notes", { archived: false, body: slug, priority: index, slug });
        }

        const first = await writer.findMany("notes", { limit: 2, orderBy: [{ priority: "asc" }] });

        expect(first.page.map((row) => row.slug)).toStrictEqual(["s1", "s2"]);
        expect(first.isDone).toBe(false);

        const second = await writer.findMany("notes", { cursor: first.continueCursor ?? undefined, limit: 2, orderBy: [{ priority: "asc" }] });

        expect(second.page.map((row) => row.slug)).toStrictEqual(["s3"]);
    });

    it("count() returns the matching row total", async () => {
        expect.assertions(2);

        const writer = makeWriter();

        await writer.insert("notes", { archived: false, body: "a", priority: 1, slug: "n1" });
        await writer.insert("notes", { archived: true, body: "b", priority: 2, slug: "n2" });

        await expect(writer.count("notes")).resolves.toBe(2);
        await expect(writer.count("notes", { where: { archived: true } })).resolves.toBe(1);
    });

    it("a foreign id can never read another table's row by id (IDOR guard)", async () => {
        expect.assertions(1);

        const writer = makeWriter();
        const id = await writer.insert("notes", { archived: false, body: "x", priority: 1, slug: "idor" });

        // Pin a different (non-existent) table — a branded id must resolve to its own table only.
        await expect(writer.get(id, "other")).resolves.toBeNull();
    });
});

/** A `notes` schema carrying a two-column rank index so the seek/before predicates emit prefix equalities. */
describe("createSqlCtxDb — the column ceiling", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    // D1 runs Workerd's SQLite build, which sets SQLITE_LIMIT_COLUMN to 100.
    // Provisioning a wider table used to fail with a bare "too many columns"
    // that named neither the table nor the ceiling.
    it("refuses to provision a global table wider than 100 columns", async () => {
        expect.assertions(1);

        const wide: SchemaLike = {
            tables: {
                wide: {
                    indexes: [],
                    shape: Object.fromEntries(Array.from({ length: 99 }, (_unused, index) => [`f${String(index)}`, col("string")])),
                    shardMode: { kind: "global" },
                },
            },
        } as never;

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: wide });

        await expect(writer.insert("wide", { f0: "x" })).rejects.toThrow(/over this engine's 100-column limit/u);
    });

    it("provisions a table that exactly fills the budget", async () => {
        expect.assertions(1);

        // 97 declared fields + the id/_creationTime/_version framework columns = 100.
        const atLimit: SchemaLike = {
            tables: {
                atLimit: {
                    indexes: [],
                    shape: Object.fromEntries(Array.from({ length: 97 }, (_unused, index) => [`f${String(index)}`, col("string")])),
                    shardMode: { kind: "global" },
                },
            },
        } as never;

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: atLimit });
        const row = Object.fromEntries(Array.from({ length: 97 }, (_unused, index) => [`f${String(index)}`, "x"]));

        expect(typeof (await writer.insert("atLimit", row))).toBe("string");
    });

    /**
     * `_version` joined the framework column set after tables were already in
     * production, dropping the declared-field ceiling from 98 to 97. A table
     * standing at the old ceiling is one column over the new one on its very
     * next request, and the engine's limit is hard — there is no `ALTER` that
     * widens a table already at 100 columns. The rejection is therefore correct
     * and unavoidable; what it must not do is read as "your schema is too wide"
     * when the schema never changed.
     */
    it("names the migration path for a table already provisioned at the pre-_version ceiling", async () => {
        expect.assertions(3);

        const fields = Array.from({ length: 98 }, (_unused, index) => `f${String(index)}`);

        // The DDL the framework itself emitted before `_version` existed:
        // id + _creationTime + 98 declared fields = exactly the 100-column limit.
        await harness.exec.run(
            `CREATE TABLE existing (id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, ${fields.map((field) => `${field} TEXT`).join(", ")})`,
            [],
        );
        await harness.exec.run(`INSERT INTO existing (id, _creationTime, f0) VALUES ('row-1', 1, 'already here')`, []);

        const existing: SchemaLike = {
            tables: {
                existing: {
                    indexes: [],
                    shape: Object.fromEntries(fields.map((field) => [field, col("string")])),
                    shardMode: { kind: "global" },
                },
            },
        } as never;

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: existing });
        const thrown = (await writer.insert("existing", { f0: "x" }).catch((error: unknown) => error)) as LunoraError;

        // Still a caller-safe VALIDATION_ERROR, so the message survives the wire.
        expect(thrown.code).toBe("VALIDATION_ERROR");
        // It says which column displaced the table and what the new ceiling is…
        expect(thrown.message).toMatch(/"_version".+caps declared fields at 97/u);
        // …and names a migration for the rows that are already in there.
        expect(thrown.message).toMatch(/defineMigration/u);
    });

    /**
     * D1 runs Workerd's SQLite build, which caps a statement at 100 BOUND
     * PARAMETERS as well as at 100 columns. The optimistic-concurrency guard used
     * to bind one parameter per physical column of the snapshot on top of one per
     * `SET` field, so an `UPDATE` bound `2N+2` — over the ceiling from 50 declared
     * fields up. `INSERT` at the same width binds `N+2` and succeeded, so the
     * table provisioned, rows went in, and only the first `patch`/`replace`/soft-
     * `delete` failed, with a raw `too many SQL variables` that redacts to
     * "Internal error" on the way out.
     *
     * `node:sqlite` allows 32,766 parameters, so nothing here throws on either
     * side of the fix — the assertion has to be on the parameter COUNT the store
     * binds, which is why this counts through a recording exec rather than
     * waiting for an engine to complain.
     */
    it("keeps every guarded write on a maximum-width table inside D1's 100-bound-parameter budget", async () => {
        expect.assertions(2);

        const FIELDS = 96;
        const shape: Record<string, unknown> = { deletedAt: optionalCol("number") };

        for (let index = 0; index < FIELDS; index += 1) {
            shape[`f${String(index)}`] = col("string");
        }

        const wide: SchemaLike = {
            tables: { wide: { indexes: [], shape, shardMode: { kind: "global" }, softDeleteMode: { field: "deletedAt" } } },
        } as never;

        const bound: number[] = [];
        const recording: SqlCtxExec = {
            all: (query, parameters) => {
                bound.push(parameters.length);

                return harness.exec.all(query, parameters);
            },
            run: (query, parameters) => {
                bound.push(parameters.length);

                return harness.exec.run(query, parameters);
            },
        };

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: recording, schema: wide });
        const row = Object.fromEntries(Array.from({ length: FIELDS }, (_unused, index) => [`f${String(index)}`, "x"]));

        const softId = await writer.insert("wide", row);
        const hardId = await writer.insert("wide", row);

        bound.length = 0;

        await writer.patch(softId, { f0: "changed" });
        await writer.replace(softId, row);
        // Soft delete (the marker field is declared) and a forced hard delete —
        // both route through the same guard.
        await writer.delete(softId);
        await writer.delete(hardId, undefined, { hard: true });

        expect(Math.max(...bound)).toBeLessThanOrEqual(100);
        // …and the writes actually landed rather than being silently skipped.
        await expect(writer.get(hardId)).resolves.toBeNull();
    });
});

const rankSchema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            rankIndexes: [
                {
                    name: "byPriority",
                    on: "notes",
                    partitionBy: ["archived"],
                    sortBy: [
                        { direction: "desc", field: "priority" },
                        { direction: "asc", field: "slug" },
                    ],
                },
            ],
            shape: {
                archived: col("boolean"),
                body: col("string"),
                priority: col("number"),
                slug: col("string"),
            },
            shardMode: { kind: "global" },
        },
    },
} as never;

/** `notes` again, with a search index so `.withSearchIndex()` is reachable. */
const searchSchema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            searchIndexes: [{ field: "body", name: "by_body" }],
            shape: { body: col("string") },
            shardMode: { kind: "global" },
        },
    },
} as never;

describe("createSqlCtxDb — search iteration terminates like collect()", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    const makeSearchWriter = () => createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: searchSchema });

    const seedMatching = async (writer: ReturnType<typeof makeSearchWriter>, count: number): Promise<void> => {
        for (let index = 0; index < count; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential inserts keep the search companion in step with the row writes
            await writer.insert("notes", { body: `alpha note ${String(index)}` });
        }
    };

    it("yields every match when the result set is under the cap", async () => {
        expect.assertions(1);

        const writer = makeSearchWriter();

        await seedMatching(writer, 5);

        const seen: unknown[] = [];

        for await (const row of writer.query("notes").withSearchIndex("by_body", (q) => q.search("body", "alpha"))) {
            seen.push(row);
        }

        expect(seen).toHaveLength(5);
    });

    it("raises the cap error rather than stopping silently at the cap", async () => {
        expect.assertions(2);

        // A search page is capped at MAX_SEARCH_SCAN, and a page sized to
        // the cap cannot fetch the probe row that tells "exactly that many
        // matches" from "ten times as many" — so `planSearchPage` refuses it
        // rather than reporting a false `isDone`. Iterating must therefore
        // raise the same cap error `.collect()` raises: same query, same data,
        // one answer.
        const writer = makeSearchWriter();

        await seedMatching(writer, MAX_SEARCH_SCAN + 1);

        const iterate = async (): Promise<void> => {
            for await (const row of writer.query("notes").withSearchIndex("by_body", (q) => q.search("body", "alpha"))) {
                expect(row).toBeUndefined(); // unreachable — the read refuses before yielding
            }
        };

        await expect(iterate()).rejects.toThrow(/documents match this search/u);
        await expect(
            writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "alpha"))
                .collect(),
        ).rejects.toThrow(/documents match this search/u);
    });

    // `.collectWithScores()` (plan 236) surfaces the relevance score the
    // sharded DO backend already computes. The three `.global()` search
    // layouts compute + order by the same `__score__` in SQL but none of them
    // selects it back out — plumbing it through all three is follow-up work,
    // not this reader alone — so this fails closed with a clear message
    // rather than a bare "not a function", mirroring `withGeoIndex()`'s
    // existing `.global()`-unsupported guard.
    it("collectWithScores() fails closed on a .global() table with a clear message", async () => {
        expect.assertions(1);

        const writer = makeSearchWriter();

        await seedMatching(writer, 1);

        await expect(
            writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "alpha"))
                .collectWithScores(),
        ).rejects.toThrow(/collectWithScores\(\) is not supported on `\.global\(\)` tables/u);
    });
});

describe("createSqlCtxDb — rank over node:sqlite", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("rank() reports a 1-based position within the partition", async () => {
        expect.assertions(3);

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: rankSchema });

        await writer.insert("notes", { archived: false, body: "a", priority: 30, slug: "a" });
        await writer.insert("notes", { archived: false, body: "b", priority: 20, slug: "b" });
        await writer.insert("notes", { archived: false, body: "c", priority: 10, slug: "c" });

        const top = await writer.findFirst("notes", { where: { slug: "a" } });
        const mid = await writer.findFirst("notes", { where: { slug: "b" } });

        await expect(writer.rank("notes", "byPriority", { row: String(top?._id) })).resolves.toEqual({ position: 1, total: 3 });
        await expect(writer.rank("notes", "byPriority", { row: String(mid?._id) })).resolves.toEqual({ position: 2, total: 3 });
        await expect(writer.rank("notes", "byPriority", { row: "missing" })).resolves.toBeNull();
    });

    it("rankPage paginates in rank order across a cursor", async () => {
        expect.assertions(2);

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: rankSchema });

        for (const [index, slug] of ["a", "b", "c"].entries()) {
            // eslint-disable-next-line no-await-in-loop -- deterministic seeding
            await writer.insert("notes", { archived: false, body: slug, priority: 30 - index * 10, slug });
        }

        const first = await writer.rankPage("notes", "byPriority", { take: 2 });

        expect(first.page.map((row) => row.slug)).toStrictEqual(["a", "b"]);

        const second = await writer.rankPage("notes", "byPriority", { cursor: first.continueCursor ?? undefined, take: 2 });

        expect(second.page.map((row) => row.slug)).toStrictEqual(["c"]);
    });
});

/** A soft-delete (`deletedAt` marker) `notes` table carrying a rank index, exercising the delete/restore/patch → rank companion seam. */
const softRankSchema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            rankIndexes: [
                {
                    name: "byPriority",
                    on: "notes",
                    partitionBy: ["archived"],
                    sortBy: [{ direction: "desc", field: "priority" }],
                },
            ],
            shape: {
                archived: col("boolean"),
                body: col("string"),
                deletedAt: optionalCol("number"),
                priority: col("number"),
                slug: col("string"),
            },
            softDeleteMode: { field: "deletedAt" },
            shardMode: { kind: "global" },
        },
    },
} as never;

describe("createSqlCtxDb — soft-delete + rank companion", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    const makeSoftRankWriter = () => createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: softRankSchema });

    it("restore() re-adds the rank entry exactly once (regression: no duplicate-PK on soft-delete tables)", async () => {
        expect.assertions(3);

        const writer = makeSoftRankWriter();

        await writer.insert("notes", { archived: false, body: "a", priority: 30, slug: "a" });
        await writer.insert("notes", { archived: false, body: "b", priority: 20, slug: "b" });

        const target = await writer.findFirst("notes", { where: { slug: "a" } });

        // Soft delete drops the row's rank companion entry.
        await writer.delete(String(target?._id));

        const afterDelete = await writer.rankPage("notes", "byPriority", { take: 10 });

        expect(afterDelete.page.map((row) => row.slug)).toStrictEqual(["b"]);

        // Previously restore()'s forced re-add double-inserted the companion row
        // and threw a raw UNIQUE-constraint (PRIMARY KEY `__id__`) violation.
        await expect(writer.restore?.(String(target?._id))).resolves.toBeUndefined();

        const afterRestore = await writer.rankPage("notes", "byPriority", { take: 10 });

        expect(afterRestore.page.map((row) => row.slug)).toStrictEqual(["a", "b"]);
    });

    it("patching a rank field of a soft-deleted row does not resurrect it in rank (regression)", async () => {
        expect.assertions(1);

        const writer = makeSoftRankWriter();

        await writer.insert("notes", { archived: false, body: "a", priority: 30, slug: "a" });
        await writer.insert("notes", { archived: false, body: "b", priority: 20, slug: "b" });

        const target = await writer.findFirst("notes", { where: { slug: "a" } });

        await writer.delete(String(target?._id));

        // An admin/cascade patch touches a RANK field (priority) of the still
        // soft-deleted row — it must NOT re-add the row to the rank companion.
        await writer.patch(String(target?._id), { priority: 99 });

        const page = await writer.rankPage("notes", "byPriority", { take: 10 });

        expect(page.page.map((row) => row.slug)).toStrictEqual(["b"]);
    });
});

/** A `.global()` table with a two-key aggregate index, so a groupBy `where` can pin a strict subset of the `by`-tuple. */
const groupSchema: SchemaLike = {
    tables: {
        events: {
            aggregateIndexes: [{ by: ["tenant", "status"], name: "byTenantStatus", on: "events", op: "count" }],
            indexes: [],
            shape: {
                status: col("string"),
                tenant: col("string"),
            },
            shardMode: { kind: "global" },
        },
    },
} as never;

describe("createSqlCtxDb — indexed groupBy honours a partial where", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("returns only the groups the where selects when it pins a subset of the by-tuple (regression: no leaked groups)", async () => {
        expect.assertions(3);

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: groupSchema });

        await writer.insert("events", { status: "active", tenant: "a" });
        await writer.insert("events", { status: "done", tenant: "a" });
        await writer.insert("events", { status: "active", tenant: "b" });

        // by=[tenant,status] with where pinning only `tenant` — the materialized
        // companion must not leak tenant "b" groups (indexed/scan divergence).
        const groups = await writer.groupBy("events", { agg: { op: "count" }, by: ["tenant", "status"], where: { tenant: "a" } });

        expect(groups).toHaveLength(2);
        expect(groups.every((entry) => (entry.key as { tenant: string }).tenant === "a")).toBe(true);
        expect(groups.some((entry) => (entry.key as { tenant: string }).tenant === "b")).toBe(false);
    });
});

/** A `notes` table carrying both an aggregate and a rank index, so one backfill pass exercises both companion-tally loops. */
const backfillSchema: SchemaLike = {
    tables: {
        notes: {
            aggregateIndexes: [{ by: ["archived"], name: "byArchived", on: "notes", op: "count" }],
            indexes: [],
            rankIndexes: [{ name: "byPriority", on: "notes", partitionBy: ["archived"], sortBy: [{ direction: "desc", field: "priority" }] }],
            shape: {
                archived: col("boolean"),
                priority: col("number"),
                slug: col("string"),
            },
            shardMode: { kind: "global" },
        },
    },
} as never;

describe("createSqlCtxDb — aggregate + rank backfills route through batch when the exec supports it", () => {
    it("issues one batch call per companion backfill (not one run() per row) when rebuilding from pre-existing rows", async () => {
        expect.assertions(3);

        const database = new DatabaseSync(":memory:");
        const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => database.prepare(query).all(...(parameters as never[]));

        const plainExec: SqlCtxExec = {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            run: (query, parameters) => {
                all(query, parameters);

                return Promise.resolve();
            },
        };

        let batchCalls = 0;
        const batchingExec: SqlCtxExec = {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            batch: (statements) => {
                batchCalls += 1;

                for (const statement of statements) {
                    all(statement.sql, statement.params);
                }

                return Promise.resolve();
            },
            run: (query, parameters) => {
                all(query, parameters);

                return Promise.resolve();
            },
        };

        try {
            // Seed the base table (and migrate the companions) through a plain
            // writer, five rows, so a from-scratch backfill has more than one
            // tally/tuple to insert.
            const seeder = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: plainExec, schema: backfillSchema });

            for (const [index, slug] of ["a", "b", "c", "d", "e"].entries()) {
                // eslint-disable-next-line no-await-in-loop -- deterministic seeding
                await seeder.insert("notes", { archived: false, priority: index, slug });
            }

            // A SECOND writer over the SAME database, with its own empty
            // backfill cache: its first write re-derives both companions from
            // scratch — the historical backfill path both loops share — this
            // time through the batching exec.
            const rebuilder = createSqlCtxDb({ clock: () => 2, dialect: makeSqliteDialect(), exec: batchingExec, schema: backfillSchema });

            await rebuilder.insert("notes", { archived: false, priority: 99, slug: "f" });

            // One batch call for the aggregate tally backfill, one for the rank
            // tuple backfill — never a run()-per-row loop.
            expect(batchCalls).toBe(2);

            const groups = await rebuilder.groupBy("notes", { agg: { op: "count" }, by: ["archived"] });

            expect(groups[0]?.value).toBe(6);

            const page = await rebuilder.rankPage("notes", "byPriority", { take: 10 });

            expect(page.page).toHaveLength(6);
        } finally {
            database.close();
        }
    });
});

describe("createSqlCtxDb — cross-dialect SQL rendering", () => {
    /** A recording exec that captures every rendered statement and answers reads from a fixed row set. */
    const recordingExec = (rows: Record<string, unknown>[]): { exec: SqlCtxExec; statements: string[] } => {
        const statements: string[] = [];

        return {
            exec: {
                all: (query) => {
                    statements.push(query);

                    return Promise.resolve(rows);
                },
                run: (query) => {
                    statements.push(query);

                    return Promise.resolve();
                },
            },
            statements,
        };
    };

    // The NULL-safe-equality operator each engine must emit (never a bare `col IS ?`, which is SQLite-only).
    const NULL_SAFE_OPERATOR = { mysql: /<=>/u, postgres: /IS NOT DISTINCT FROM/u } as const;

    it.each([
        ["mysql", Object.assign(new Error("Row size too large (8126)"), { errno: 1118 }), "InnoDB's per-row ceiling"],
        ["postgres", new Error("row is too big: size 8168, maximum size 8160"), "8 KB heap page"],
    ] as const)("maps the %s row-size error to PAYLOAD_TOO_LARGE rather than a redacted INTERNAL", async (engine, raised, limitText) => {
        expect.assertions(3);

        // Neither engine phrases the overflow the way SQLite does, so the
        // recogniser has to key on each one's own shape — MySQL's
        // `ER_TOO_BIG_ROWSIZE` errno, Postgres' "row is too big" message. Without
        // it the raw driver error is not a LunoraError and `toErrorBody` redacts
        // it to INTERNAL / 500.
        const exec: SqlCtxExec = {
            all: () => Promise.resolve([]),
            run: (query) => (/^\s*insert into/iu.test(query) ? Promise.reject(raised) : Promise.resolve()),
        };
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(engine), exec, schema });

        const error = await writer.insert("notes", { archived: false, body: "x", priority: 1, slug: "s" }).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(LunoraError);
        expect((error as LunoraError).code).toBe("PAYLOAD_TOO_LARGE");
        expect((error as LunoraError).message).toContain(limitText);
    });

    it.each(["postgres", "mysql"] as const)("renders the %s OCC guard with engine-correct NULL-safe equality", async (engine) => {
        expect.assertions(2);

        // A patch snapshots the row then issues a guarded UPDATE whose WHERE uses
        // NULL-safe equality on every column. On Postgres that must be
        // `IS NOT DISTINCT FROM`, on MySQL `<=>`.
        const snapshotRow = { _creationTime: 1, archived: 0, body: "x", id: "row1", priority: 1, slug: "s" };
        // get/patch both read; return the row for every SELECT, plus an `id` for the RETURNING CAS.
        const { exec, statements } = recordingExec([snapshotRow]);
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(engine), exec, schema });

        await writer.patch("row1", { body: "y" });

        const guarded = statements.find((statement) => /update .*notes.* set/iu.test(statement));

        expect(guarded).toBeDefined();
        expect(guarded).toMatch(NULL_SAFE_OPERATOR[engine]);
    });

    it.each(["postgres", "mysql"] as const)(
        "renders the %s rankPage cursor seek with engine-correct prefix equality (regression: bare `IS` is SQLite-only)",
        async (engine) => {
            expect.assertions(2);

            // A cursor-seeked rankPage emits an OR-of-AND seek whose prefix columns
            // are fixed by NULL-safe equality. Those prefix equalities must render
            // as `IS NOT DISTINCT FROM` (Postgres) / `<=>` (MySQL).
            // rankTableExists → non-empty so the companion counts as "exists";
            // the backfill source scan then reads from the same set (harmless).
            const { exec, statements } = recordingExec([{ __id__: "x", __partition__: "0", sort_0: 30, sort_1: "a" }]);
            const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(engine), exec, schema: rankSchema });

            // A 4-element cursor matches [partition, sort_0, sort_1, __id__].
            // Minted the way the engine mints them: `decodeCursor` refuses a
            // cursor without the format marker.
            const cursor = CURSOR_PREFIX + btoa(JSON.stringify(["0", 30, "a", "x"]));

            await writer.rankPage("notes", "byPriority", { cursor, take: 2 });

            const seek = statements.find((statement) => /from .*__rank_bypriority.* where/iu.test(statement));

            expect(seek).toBeDefined();
            expect(seek).toMatch(NULL_SAFE_OPERATOR[engine]);
        },
    );

    /** `notes` plus a nullable ordered column, so a page can straddle a null group. */
    const publishedSchema: SchemaLike = {
        tables: {
            posts: {
                indexes: [],
                shape: { publishedAt: optionalCol("number"), title: col("string") },
                shardMode: { kind: "global" },
            },
        },
    } as never;

    it.each(["postgres", "mysql", "sqlite"] as const)("renders the %s ORDER BY with the NULL placement the shared keyset seek assumes", async (engine) => {
        expect.assertions(2);

        const { exec, statements } = recordingExec([]);
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(engine), exec, schema: publishedSchema });

        await writer.findMany("posts", { limit: 20, orderBy: [{ publishedAt: "desc" }] });

        const listed = statements.find((statement) => /select \* from .*posts.*order by/iu.test(statement));

        expect(listed).toBeDefined();

        // `buildSeekWhere` is dialect-blind and fixes ONE NULL placement:
        // NULLs first ascending, last descending — the SQLite/MySQL default.
        // Postgres is the mirror (`DESC` implies NULLS FIRST), so leaning on
        // its default puts the null group on the side the seek does not
        // expect: page 2's `OR publishedAt IS NULL` arm re-selects those rows
        // and Postgres sorts them back to the top of every following page, so
        // with at least `limit` null rows the cursor stops advancing and the
        // feed loops on one page. Stating the placement is what keeps the two
        // in agreement. MySQL has no `NULLS` clause in its grammar at all, and
        // SQLite already agrees, so neither may be given one.
        expect(listed).toMatch(engine === "postgres" ? /desc nulls last/iu : /desc(?! nulls)/iu);
    });

    /**
     * `KEY` is a reserved word in MySQL 8 and cannot be an unquoted alias, so the
     * enumerate statement the indexed `groupBy` fast path emits died with
     * `ER_PARSE_ERROR` on every `groupBy` whose `by` matches an `aggregateIndex`
     * and carries no `where` — the most common grouped-count shape there is. The
     * companion tables are always provisioned, so the SQL `GROUP BY` fallback
     * never ran and the whole call was a 500.
     *
     * `sql.identifier` was applied to the source column but not to the alias;
     * routing the alias through it too lets drizzle quote it the way each engine
     * expects (backticks on MySQL, double quotes elsewhere).
     */
    it.each(["postgres", "mysql", "sqlite"] as const)("quotes the indexed groupBy enumerate aliases on %s", async (engine) => {
        expect.assertions(2);

        // One companion row, which also answers the `tableExists` probe so the
        // indexed path is taken rather than the SQL `GROUP BY` fallback.
        const { exec, statements } = recordingExec([{ count: 1, key: JSON.stringify(["a", "active"]), value: null }]);
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(engine), exec, schema: groupSchema });

        await writer.groupBy("events", { agg: { op: "count" }, by: ["tenant", "status"] });

        const enumerated = statements.find((statement) => /^select .*__agg_bytenantstatus/iu.test(statement));

        expect(enumerated).toBeDefined();
        expect(enumerated).toMatch(engine === "mysql" ? /as `key`/iu : /as "key"/iu);
    });

    it("leaves a notNull ordered column's ORDER BY bare on Postgres", async () => {
        expect.assertions(2);

        // The placement clause is not free: Postgres cannot answer
        // `ORDER BY c DESC NULLS LAST` from a plain btree walk, so it is emitted
        // only where a null group can exist. `notes.priority` is declared notNull.
        const { exec, statements } = recordingExec([]);
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect("postgres"), exec, schema });

        await writer.findMany("notes", { limit: 20, orderBy: [{ priority: "desc" }] });

        const listed = statements.find((statement) => /select \* from .*notes.*order by/iu.test(statement));

        expect(listed).toBeDefined();
        expect(listed).not.toMatch(/nulls (first|last)/iu);
    });
});

describe("createSqlCtxDb — _creationTime is server-authoritative", () => {
    /** A recording exec that captures every rendered statement WITH its bound params, answering reads from a fixed row set. */
    const recordingExecWithParams = (rows: Record<string, unknown>[]): { calls: { params: ReadonlyArray<unknown>; sql: string }[]; exec: SqlCtxExec } => {
        const calls: { params: ReadonlyArray<unknown>; sql: string }[] = [];

        return {
            calls,
            exec: {
                all: (query, parameters) => {
                    calls.push({ params: parameters, sql: query });

                    return Promise.resolve(rows);
                },
                run: (query, parameters) => {
                    calls.push({ params: parameters, sql: query });

                    return Promise.resolve();
                },
            },
        };
    };

    // A fixed clock so a minted `_creationTime` is a distinctive, assertable value.
    const CLOCK = 999;

    it("insert() WITHOUT allowExplicitId mints clock() and ignores a forged document _creationTime", async () => {
        expect.assertions(3);

        const { calls, exec } = recordingExecWithParams([]);
        const writer = createSqlCtxDb({ clock: () => CLOCK, dialect: makeSqliteDialect(), exec, schema });

        // A raw-forwarded client payload smuggling a backdated `_creationTime`.
        await writer.insert("notes", { _creationTime: 1, archived: false, body: "x", priority: 3, slug: "forge" });

        const insert = calls.find((call) => /insert into .*notes.* values/iu.test(call.sql));

        expect(insert).toBeDefined();
        // Values tuple is [id, _creationTime, ...fields], so the minted clock() lands at index 1 — never the forged 1.
        expect(insert?.params[1]).toBe(CLOCK);
        expect(insert?.params).not.toContain(1);
    });

    it("insert() WITH allowExplicitId honors the document _creationTime (import/CDC preservation)", async () => {
        expect.assertions(2);

        const { calls, exec } = recordingExecWithParams([]);
        const writer = createSqlCtxDb({ clock: () => CLOCK, dialect: makeSqliteDialect(), exec, schema });

        // The trusted import/CDC path opts in to preserve the original creation time.
        await writer.insert("notes", { _creationTime: 1, archived: false, body: "x", priority: 3, slug: "import" }, { allowExplicitId: true });

        const insert = calls.find((call) => /insert into .*notes.* values/iu.test(call.sql));

        expect(insert).toBeDefined();
        expect(insert?.params[1]).toBe(1);
    });

    it("replace() mints clock() and ignores a forged document _creationTime", async () => {
        expect.assertions(3);

        // resolveTableName + the OCC snapshot both read; return this row for every SELECT.
        const snapshotRow = { _creationTime: 42, archived: 0, body: "x", id: "row1", priority: 1, slug: "s" };
        const { calls, exec } = recordingExecWithParams([snapshotRow]);
        const writer = createSqlCtxDb({ clock: () => CLOCK, dialect: makeSqliteDialect(), exec, schema });

        await writer.replace("row1", { _creationTime: 5, archived: false, body: "y", priority: 7, slug: "s" });

        const update = calls.find((call) => /update .*notes.* set/iu.test(call.sql));

        expect(update).toBeDefined();
        // The SET clause binds `_creationTime = ?` first, so the minted clock() is the leading param — never the forged 5.
        expect(update?.params[0]).toBe(CLOCK);
        expect(update?.params).not.toContain(5);
    });
});

describe("createSqlCtxDb — the `.global()` changelog", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    /** A CDC-enabled writer over the real SQLite harness. */
    const makeCdcWriter = () => createSqlCtxDb({ cdc: true, clock: () => 1_700_000_000_000, dialect: makeSqliteDialect(), exec: harness.exec, schema });

    it("reports the tables written after a cursor, and the log head", async () => {
        expect.assertions(3);

        const writer = makeCdcWriter();

        await writer.insert("notes", { archived: false, body: "a", priority: 1, slug: "a" });

        const first = await writer.cdcChangedTables?.(0);

        expect(first).toMatchObject({ tables: ["notes"] });
        expect(first?.cursor).toBeGreaterThan(0);

        // Nothing has been written since that head, so the poll it drives has
        // nothing to re-read — which is the steady state the fast path exists for.
        const quiet = await writer.cdcChangedTables?.(first?.cursor ?? 0);

        expect(quiet).toMatchObject({ tables: [] });
    });

    it("bounds the table scan by the head it returns, so a concurrent write is not lost", async () => {
        expect.assertions(2);

        const writer = makeCdcWriter();

        await writer.insert("notes", { archived: false, body: "a", priority: 1, slug: "a" });

        const opened = await writer.cdcChangedTables?.(0);
        const head = opened?.cursor ?? 0;

        // A write landing after the head was read must sit ABOVE the cursor the
        // caller adopts — never inside the range it believes it has covered, which
        // is what reading the head last would have produced.
        await writer.insert("notes", { archived: false, body: "b", priority: 1, slug: "b" });

        const next = await writer.cdcChangedTables?.(head);

        expect(next?.tables).toStrictEqual(["notes"]);
        expect(next?.cursor).toBeGreaterThan(head);
    });

    it("round-trips a bigint / bytes post-image through the changelog", async () => {
        expect.assertions(3);

        const dialect = makeSqliteDialect();
        const wireSchema: SchemaLike = {
            tables: {
                ledger: {
                    indexes: [],
                    shape: { blob: col("bytes"), cents: col("bigint") },
                    shardMode: { kind: "global" },
                },
            },
        } as never;

        const writer = createSqlCtxDb({ cdc: true, clock: () => 1_700_000_000_000, dialect, exec: harness.exec, schema: wireSchema });

        // A bare `JSON.stringify` of the post-image THROWS on the bigint (after
        // the row is already committed) and silently records `{}` for the bytes.
        await writer.insert("ledger", { blob: new Uint8Array([1, 2, 3]).buffer, cents: 9_007_199_254_740_993n });

        const { changes } = await readSqlCdcChanges(harness.exec, {}, dialect);

        expect(changes).toHaveLength(1);
        expect(changes[0]?.doc?.["cents"]).toBe(9_007_199_254_740_993n);
        expect([...new Uint8Array(changes[0]?.doc?.["blob"] as ArrayBuffer)]).toStrictEqual([1, 2, 3]);
    });

    it("reports no visibility when CDC is disabled, rather than throwing", async () => {
        expect.assertions(1);

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema });

        // `undefined` is the contract's "fall back to re-reading" signal — the
        // behaviour every caller had before this method existed.
        const blind = await writer.cdcChangedTables?.(0);

        expect(blind).toBeUndefined();
    });

    it("applies a key prefix to the changelog index only where the engine demands one", async () => {
        expect.assertions(4);

        /** Captures the DDL a writer renders, so the index can be asserted without a MySQL engine to run it on. */
        const capturingExec = (): { exec: SqlCtxExec; statements: string[] } => {
            const statements: string[] = [];

            return {
                exec: {
                    all: (query) => {
                        statements.push(query);

                        return Promise.resolve([]);
                    },
                    run: (query) => {
                        statements.push(query);

                        return Promise.resolve();
                    },
                },
                statements,
            };
        };

        const createIndexFor = async (indexKeyPrefix?: SqlDialect["indexKeyPrefix"]): Promise<string> => {
            const { exec, statements } = capturingExec();

            await createSqlCtxDb({ cdc: true, clock: () => 1, dialect: { ...makeSqliteDialect(), indexKeyPrefix }, exec, schema }).insert("notes", {
                archived: false,
                body: "a",
                priority: 1,
                slug: "a",
            });

            return statements.find((statement) => /create index .*__cdc_log_table_seq/iu.test(statement)) ?? "";
        };

        // MySQL's `key` type is VARCHAR(768) BECAUSE 768 utf8mb4 characters is
        // InnoDB's single-column index limit — so a composite `("table", seq)`
        // built without a prefix is over that limit and the migration fails with
        // ER_TOO_LONG_KEY. The prefix bounds `table`'s contribution; `seq` is an
        // integer and must never carry one.
        // Asserted on the column list rather than the whole statement: the index
        // NAME contains "table_seq", so a looser pattern matches itself.
        // The column list is what follows the first `(` after `ON <table>` — not
        // the last `(`, which on the prefixed form is the prefix's own.
        const columnsOf = (statement: string): string => statement.slice(statement.indexOf("(", statement.indexOf(" ON ")) + 1, statement.lastIndexOf(")"));

        const prefixed = await createIndexFor(() => 191);
        const plain = await createIndexFor();

        expect(columnsOf(prefixed)).toBe(`"table"(191), "seq"`);
        expect(prefixed).toMatch(/__cdc_log_table_seq/u);

        // An engine that indexes text directly gets the whole column, and `seq` —
        // an integer — is never prefixed on either.
        expect(columnsOf(plain)).toBe(`"table", "seq"`);
        expect(plain).not.toMatch(/\(191\)/u);
    });
});

/**
 * Declared indexes on a global table now carry the default sort keys, the way
 * `@lunora/shard-engine`'s `INDEX_SORT_KEYS` has on the DO side — this backend
 * simply never got the fix, and the ORDER BY builder's own doc used to say so.
 *
 * An index on the filter columns ALONE cannot satisfy `ORDER BY _creationTime,
 * id`, so the engine reads every matching row into a temp B-tree to return a
 * page. Measured on `node:sqlite`, 50k rows, 1k per key:
 *
 * ```
 * WHERE status = ? ORDER BY _creationTime, id LIMIT 21
 *   fields-only index   140.9us  SEARCH (status=?) | USE TEMP B-TREE FOR ORDER BY
 *   + sort keys          19.6us  SEARCH (status=?)
 * unfiltered, same page
 *   no default index   1649.9us  SCAN notes | USE TEMP B-TREE FOR ORDER BY
 *   + __by_creation      21.2us  SCAN notes USING INDEX notes__by_creation
 * ```
 *
 * Skipped on an engine that needs a key prefix to index text (MySQL): `id` is
 * `VARCHAR(768)` there, which is InnoDB's whole-index key limit on its own, so
 * appending it to another column fails `CREATE INDEX` with ER_TOO_LONG_KEY.
 */
describe("global table index sort keys", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    const indexedSchema: SchemaLike = {
        tables: {
            posts: {
                indexes: [
                    { fields: ["status"], name: "by_status" },
                    { fields: ["slug"], name: "by_slug", unique: true },
                ],
                shape: { slug: col("string"), status: col("string"), title: col("string") },
                shardMode: { kind: "global" },
            },
        },
    } as never;

    /** Provision the schema (migrations run lazily on the first read) and return the DDL SQLite kept for `name`. */
    const provisionedIndex = async (name: string): Promise<string> => {
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: indexedSchema });

        await writer.findMany("posts", { limit: 1 });

        const rows = await harness.exec.all(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, [name]);
        const ddl = rows[0]?.["sql"];

        return typeof ddl === "string" ? ddl : "";
    };

    it("refuses to drop a UNIQUE index it cannot re-create, rather than leaving the table unprotected", async () => {
        expect.assertions(2);

        // Provision once so `posts_by_slug` exists as a UNIQUE index on `slug`.
        await provisionedIndex("posts_by_slug");

        // Two rows that are distinct under `slug` but DUPLICATES under the new
        // column list. Written straight through the harness so the existing
        // constraint does not reject them.
        await harness.exec.run(`INSERT INTO "posts" ("id", "_creationTime", "slug", "status", "title") VALUES (?, ?, ?, ?, ?)`, ["p1", 1, "a", "draft", "t"]);
        await harness.exec.run(`INSERT INTO "posts" ("id", "_creationTime", "slug", "status", "title") VALUES (?, ?, ?, ?, ?)`, ["p2", 2, "b", "draft", "t"]);

        // Re-declare the same unique index over a DIFFERENT column, which the
        // two rows above violate. Dropping first would remove the old constraint
        // and then fail to create the new one, leaving no constraint at all —
        // and the failed migration re-runs and re-fails on every wake.
        const changed: SchemaLike = {
            tables: {
                posts: {
                    indexes: [
                        { fields: ["status"], name: "by_status" },
                        { fields: ["status"], name: "by_slug", unique: true },
                    ],
                    shape: { slug: col("string"), status: col("string"), title: col("string") },
                    shardMode: { kind: "global" },
                },
            },
        } as never;

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: changed });

        await expect(writer.findMany("posts", { limit: 1 })).rejects.toThrow(/cannot be re-created/u);

        // The original constraint is still in force.
        const rows = await harness.exec.all(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, ["posts_by_slug"]);

        const held = rows[0]?.["sql"];

        expect(typeof held === "string" ? held : "").toContain("slug");
    });

    it("appends the sort keys to a declared index, and the default sort gets an index of its own", async () => {
        expect.assertions(3);

        await expect(provisionedIndex("posts_by_status")).resolves.toMatch(/"status".*"_creationTime".*"id"/su);
        await expect(provisionedIndex("posts__by_creation")).resolves.toMatch(/"_creationTime".*"id"/su);

        const plan = await harness.exec.all(`EXPLAIN QUERY PLAN SELECT * FROM "posts" WHERE "status" = ? ORDER BY "_creationTime" ASC, "id" ASC LIMIT 21`, [
            "published",
        ]);

        expect(plan.map((step) => String(step["detail"])).join(" | ")).not.toContain("TEMP B-TREE");
    });

    it("skips the sort keys on an engine that must prefix its text index keys", async () => {
        expect.assertions(2);

        // MySQL declares `id VARCHAR(768)`: 768 utf8mb4 characters is 3072 bytes,
        // exactly InnoDB's whole-index key limit, so `(status(191), _creationTime,
        // id)` fails CREATE INDEX with ER_TOO_LONG_KEY and the migration takes the
        // whole table with it. Prefixing `id` would create but buy nothing —
        // MySQL cannot satisfy an ORDER BY from a prefixed column.
        const statements: string[] = [];
        const exec: SqlCtxExec = {
            all: () => Promise.resolve([]),
            run: (query) => {
                statements.push(query);

                return Promise.resolve();
            },
        };
        const dialect: SqlDialect = { ...makeSqliteDialect("mysql"), indexKeyPrefix: (kind) => (kind === "string" ? 191 : undefined) };
        const writer = createSqlCtxDb({ clock: () => 1, dialect, exec, schema: indexedSchema });

        await writer.findMany("posts", { limit: 1 });

        // `.every` over an empty list is vacuously true, so assert the statement
        // was actually issued before asserting anything about its shape.
        const declared = statements.filter((query) => query.includes("posts_by_status"));

        expect(declared).toHaveLength(1);
        expect(`${String(declared[0])} ${statements.filter((query) => query.includes("__by_creation")).join(" ")}`).not.toContain("_creationTime");
    });

    it("leaves a UNIQUE index alone, so the constraint keeps rejecting duplicates", async () => {
        expect.assertions(2);

        // `(slug, _creationTime, id)` is unique for every row, so appending the
        // sort keys here would silently stop the constraint working — data
        // corruption rather than a slow query.
        await expect(provisionedIndex("posts_by_slug")).resolves.not.toMatch(/_creationTime/u);

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: indexedSchema });

        await writer.insert("posts", { slug: "a", status: "draft", title: "t" });

        // The store maps the engine's breach to its own ConflictError, which is
        // the observable proof the UNIQUE index is still enforcing.
        await expect(writer.insert("posts", { slug: "a", status: "draft", title: "u" })).rejects.toThrow(/unique constraint violation/iu);
    });

    it("replaces an index a previous version provisioned without the sort keys", async () => {
        expect.assertions(2);

        // `CREATE INDEX IF NOT EXISTS` is a no-op against an index that exists
        // with a DIFFERENT definition, so without an explicit drop an already
        // provisioned database would keep the old shape forever and silently
        // miss the improvement. Simulate that database.
        await harness.exec.run(`CREATE TABLE "posts" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "slug" TEXT, "status" TEXT, "title" TEXT)`, []);
        await harness.exec.run(`CREATE INDEX "posts_by_status" ON "posts" ("status")`, []);

        const before = await harness.exec.all(`SELECT sql FROM sqlite_master WHERE name = 'posts_by_status'`, []);

        expect(String(before[0]?.["sql"])).not.toMatch(/_creationTime/u);
        await expect(provisionedIndex("posts_by_status")).resolves.toMatch(/_creationTime/u);
    });
});
