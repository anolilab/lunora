/**
 * The FTS5 search companion under writers from separate isolates, against a
 * **real** D1 binding in workerd.
 *
 * A `.global()` store is one D1 database shared by every isolate, and the
 * single-flight memo that runs a backfill page on cold start is per isolate. So
 * a backfill page and a write from another isolate interleave, and so do two
 * cold starts. Each test drives that interleaving deterministically: one exec
 * is paused at a chosen companion statement while the other runs to completion.
 *
 * Every table crosses the 200-row backfill page, and every assertion counts
 * companion rows rather than asking whether a document is "indexed" — a
 * document indexed twice is indexed too.
 *
 * Each test owns its table names; D1 storage is shared across this file.
 */
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../../src/ctx-db";
import { createSqlCtxDb } from "../../src/ctx-db";
import { backfillSqlSearchIndexes, runSqlSearchMigrations } from "../../src/ctx-db-search";
import { migrateSearchState, writeSearchBackfillState } from "../../src/ctx-db-search-state";
import type { SqlDialect } from "../../src/dialect";
import { companionProfile } from "../../src/search-layout";

const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;
const SQL_AFFINITY: Record<string, string> = { boolean: "INTEGER", number: "REAL" };

/** `@lunora/d1`'s dialect, FTS5 included — the layout D1 actually uses. */
const d1Dialect: SqlDialect = {
    columnType: (kind) => SQL_AFFINITY[kind ?? ""] ?? "TEXT",
    companionTypes: { autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT", integer: "INTEGER", key: "TEXT", real: "REAL", text: "TEXT" },
    frameworkColumns: () => [
        { name: "id", type: "TEXT PRIMARY KEY" },
        { name: "_creationTime", type: "REAL NOT NULL" },
    ],
    isUniqueViolation: (error) => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message),
    maxTableColumns: 100,
    name: "sqlite",
    supportsFts5: true,
    supportsReturning: true,
    tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
};

const INDEX = { field: "body", filterFields: [], name: "by_body" };
const ROWS = 250;
const CLOCK = (): number => 1_700_000_000_000;

const column = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schemaFor = (table: string, index?: Record<string, unknown>): SchemaLike =>
    ({
        tables: {
            [table]: {
                indexes: [],
                searchIndexes: index ? [index] : [],
                shape: { body: column("string"), title: column("string") },
                shardMode: { kind: "global" },
            },
        },
    }) as never;

type Gate = (text: string, parameters: ReadonlyArray<unknown>) => Promise<void>;

/** A `SqlCtxExec` over the D1 binding, optionally awaiting `gate` before each statement. */
const d1Exec = (gate?: Gate, onRun?: (text: string, rowsRead: number) => void): SqlCtxExec => {
    return {
        all: async (query, parameters) => {
            await gate?.(query, parameters);

            const result = await env.DB.prepare(query)
                .bind(...parameters)
                .all();

            return result.results;
        },
        // D1's own `batch`: the statements run in order, as one transaction. A
        // gate sees each statement before any of them runs, so a batch is held
        // whole — nothing can land between its statements, as in production.
        batch: async (statements) => {
            for (const statement of statements) {
                // eslint-disable-next-line no-await-in-loop -- each statement is offered to the gate in order
                await gate?.(statement.sql, statement.params);
            }

            const results = await env.DB.batch(statements.map((statement) => env.DB.prepare(statement.sql).bind(...statement.params)));

            for (const [position, result] of results.entries()) {
                onRun?.(statements[position]!.sql, result.meta.rows_read);
            }
        },
        run: async (query, parameters) => {
            await gate?.(query, parameters);

            const result = await env.DB.prepare(query)
                .bind(...parameters)
                .run();

            onRun?.(query, result.meta.rows_read);
        },
    };
};

const pad = (n: number): string => `r${String(n).padStart(4, "0")}`;

const companionOf = (table: string): string => `${table}__fts_${INDEX.name}`;

/** Write `ROWS` rows while the table has no search index, so none of them is indexed. */
const seed = async (table: string, body: (n: number) => string): Promise<void> => {
    const writer = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(), schema: schemaFor(table) });

    for (let n = 0; n < ROWS; n += 1) {
        // eslint-disable-next-line no-await-in-loop -- rows are seeded in order
        await writer.insert(table, { _id: pad(n), body: body(n), title: "t" }, { allowExplicitId: true });
    }
};

/**
 * A gate that holds the first statement matching `matches` until `release()`, and
 * reports reaching it through `reached`.
 */
const holdAt = (matches: (text: string, parameters: ReadonlyArray<unknown>) => boolean): { gate: Gate; reached: Promise<void>; release: () => void } => {
    let release!: () => void;
    let reach!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
        reach = resolve;
    });
    let held = false;

    return {
        gate: async (text, parameters) => {
            if (!held && matches(text, parameters)) {
                held = true;
                reach();
                await released;
            }
        },
        reached,
        release,
    };
};

/**
 * The two points a backfill page can be caught at for one document: before its
 * first statement touching the companion, and at the statement that writes the
 * searchable entry itself (after any purge or rowid claim).
 */
const holdPoints = (table: string, target: string): [string, (text: string, parameters: ReadonlyArray<unknown>) => boolean][] => [
    ["before its first companion statement for the row", (text, parameters) => text.includes(`"${companionOf(table)}`) && parameters.includes(target)],
    [
        "at the statement writing the row's entry",
        (text, parameters) => new RegExp(String.raw`^INSERT\b.*\bINTO "${companionOf(table)}" `, "u").test(text) && parameters.includes(target),
    ],
];

const companionRows = async (table: string, id?: string): Promise<number> => {
    const companion = companionOf(table);
    // Documents only: the companion also holds a text-less sentinel row with an empty id.
    const where = id === undefined ? ` WHERE "${companion}"."__id__" <> ''` : ` WHERE "${companion}"."__id__" = ?`;
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${companion}"${where}`)
        .bind(...(id === undefined ? [] : [id]))
        .first<{ n: number }>();

    return row?.n ?? -1;
};

const distinctIndexed = async (table: string): Promise<number> => {
    const companion = companionOf(table);
    const row = await env.DB.prepare(`SELECT COUNT(DISTINCT "${companion}"."__id__") AS n FROM "${companion}" WHERE "${companion}"."__id__" <> ''`).first<{
        n: number;
    }>();

    return row?.n ?? -1;
};

const search = async (table: string, term: string): Promise<unknown[]> => {
    const reader = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(), schema: schemaFor(table, INDEX) });
    const hits = await reader
        .query(table)
        .withSearchIndex(INDEX.name, (q) => q.search("body", term))
        .collect();

    return hits.map((hit) => hit["_id"]);
};

describe("fts5 search companion across isolates on D1 in workerd", () => {
    it.each(holdPoints("stale_a", pad(150)).map(([label], at) => [label, at] as const))(
        "a backfill page that read a row before another isolate rewrote it keeps the fresh entry (held %s)",
        async (_label, at) => {
            expect.assertions(5);

            const table = at === 0 ? "stale_a" : "stale_b";
            const target = pad(150);

            await seed(table, (n) => (n === 150 ? "staleword common" : `other${String(n)} common`));

            // Isolate A: the cold-start page, held at the target row.
            const hold = holdAt(holdPoints(table, target)[at]![1]);
            const isolateA = runSqlSearchMigrations(d1Exec(hold.gate), schemaFor(table, INDEX), d1Dialect);

            await hold.reached;

            // Isolate B: its own cold start, then a write to the row A already read.
            const isolateB = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(), schema: schemaFor(table, INDEX) });

            await isolateB.patch(target, { body: "freshword common" });

            hold.release();
            await isolateA;
            await backfillSqlSearchIndexes(d1Exec(), schemaFor(table, INDEX), d1Dialect);

            await expect(search(table, "freshword")).resolves.toStrictEqual([target]);
            await expect(search(table, "staleword")).resolves.toStrictEqual([]);
            await expect(companionRows(table, target)).resolves.toBe(1);
            await expect(companionRows(table)).resolves.toBe(ROWS);
            await expect(distinctIndexed(table)).resolves.toBe(ROWS);
        },
    );

    it("never exposes the stale entry, even before the page re-checks what it wrote", async () => {
        expect.assertions(1);

        // Held twice: at the row, while another isolate rewrites it, and then
        // again just before the page re-reads what it wrote. At that second
        // point every write of the page has landed, so a write that did not
        // check the row it read would be sitting in the companion right now.
        const table = "stale_window";
        const target = pad(150);

        await seed(table, (n) => (n === 150 ? "staleword common" : `other${String(n)} common`));

        const atRow = holdAt(holdPoints(table, target)[0]![1]);
        const atRecheck = holdAt((text) => text.startsWith(`SELECT * FROM "${table}" WHERE "id" >=`));
        const isolateA = runSqlSearchMigrations(
            d1Exec(async (text, parameters) => {
                await atRow.gate(text, parameters);
                await atRecheck.gate(text, parameters);
            }),
            schemaFor(table, INDEX),
            d1Dialect,
        );

        await atRow.reached;
        await createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(), schema: schemaFor(table, INDEX) }).patch(target, { body: "freshword common" });
        atRow.release();
        await atRecheck.reached;

        const companion = companionOf(table);
        const entries = await env.DB.prepare(`SELECT "${companion}"."__text__" AS t FROM "${companion}" WHERE "${companion}"."__id__" = ?`)
            .bind(target)
            .all<{ t: string }>();

        atRecheck.release();
        await isolateA;

        expect(entries.results.map((entry) => entry.t)).toStrictEqual(["freshword common"]);
    });

    it("indexes a row whose concurrent write left the indexed text alone", async () => {
        expect.assertions(3);

        // `staged`, so isolate B's cold start does not backfill and its write is
        // the only other thing touching the row — and a write that leaves the
        // indexed text alone skips the companion entirely. A backfill that gives
        // way to "the fresher writer" would leave this row unindexed for good.
        const table = "untouched_text";
        const staged = { ...INDEX, staged: true };
        const target = pad(210);

        await seed(table, (n) => (n === 210 ? "needle common" : `other${String(n)} common`));

        const hold = holdAt(holdPoints(table, target)[0]![1]);
        const isolateA = backfillSqlSearchIndexes(d1Exec(hold.gate), schemaFor(table, staged), d1Dialect);

        await hold.reached;

        const isolateB = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(), schema: schemaFor(table, staged) });

        await isolateB.patch(target, { title: "renamed" });

        hold.release();
        await isolateA;

        await expect(search(table, "needle")).resolves.toStrictEqual([target]);
        await expect(companionRows(table, target)).resolves.toBe(1);
        await expect(companionRows(table)).resolves.toBe(ROWS);
    });

    it.each(holdPoints("dup_a", pad(10)).map(([label], at) => [label, at] as const))(
        "two cold-start backfill pages racing over one row index it once and rank it correctly (held %s)",
        async (_label, at) => {
            expect.assertions(4);

            const table = at === 0 ? "dup_a" : "dup_b";
            const target = pad(10);

            // Identical text and `_creationTime`, so the tiebreak is `id ASC`: r0005 first.
            await seed(table, (n) => (n === 5 || n === 10 ? "apple common" : `other${String(n)} common`));

            const hold = holdAt(holdPoints(table, target)[at]![1]);
            const isolateA = runSqlSearchMigrations(d1Exec(hold.gate), schemaFor(table, INDEX), d1Dialect);

            await hold.reached;
            // Isolate B: a whole cold-start page while A is mid-page.
            await runSqlSearchMigrations(d1Exec(), schemaFor(table, INDEX), d1Dialect);
            hold.release();
            await isolateA;
            await backfillSqlSearchIndexes(d1Exec(), schemaFor(table, INDEX), d1Dialect);

            await expect(companionRows(table, target)).resolves.toBe(1);
            await expect(companionRows(table)).resolves.toBe(ROWS);
            await expect(distinctIndexed(table)).resolves.toBe(ROWS);
            await expect(search(table, "apple")).resolves.toStrictEqual([pad(5), pad(10)]);
        },
    );

    it("reads a bounded number of companion rows per write, however large the companion", async () => {
        expect.assertions(3);

        const cost = async (size: number): Promise<number> => {
            const table = `cost_${String(size)}`;

            // The table itself, then its rows in bulk — nothing here is under test.
            await createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(), schema: schemaFor(table) }).count(table);

            for (let start = 0; start < size; start += 50) {
                const values = Array.from({ length: Math.min(50, size - start) }, (_, offset) => {
                    const n = start + offset;

                    return `('d${String(n).padStart(5, "0")}', 1, 't', 'word${String(n)} common')`;
                });

                // eslint-disable-next-line no-await-in-loop -- bulk seed in order
                await env.DB.prepare(`INSERT INTO "${table}" ("id", "_creationTime", "title", "body") VALUES ${values.join(", ")}`).run();
            }

            await backfillSqlSearchIndexes(d1Exec(), schemaFor(table, INDEX), d1Dialect);

            let rowsRead = 0;
            const writer = createSqlCtxDb({
                clock: CLOCK,
                dialect: d1Dialect,
                exec: d1Exec(undefined, (text, read) => {
                    if (text.includes(`"${companionOf(table)}`)) {
                        rowsRead += read;
                    }
                }),
                schema: schemaFor(table, INDEX),
            });

            // Its cold start first, so only the two writes are measured.
            await writer.count(table);
            rowsRead = 0;

            await writer.patch("d00005", { body: "changed text" });
            await writer.delete("d00007");

            return rowsRead;
        };

        const small = await cost(100);
        const large = await cost(2000);

        // eslint-disable-next-line no-console -- the measurement is the point of this test
        console.info(`companion rows_read for one patch + one delete: 100 rows -> ${String(small)}, 2000 rows -> ${String(large)}`);

        expect(small).toBeGreaterThan(0);
        expect(large).toBeLessThan(50);
        expect(large).toBe(small);
    });

    it("leaves no entry the map cannot reach when a delete races a write of the same document", async () => {
        expect.assertions(2);

        const table = "write_vs_delete";
        const companion = companionOf(table);
        const target = pad(40);

        await seed(table, (n) => `word${String(n)} common`);
        await backfillSqlSearchIndexes(d1Exec(), schemaFor(table, INDEX), d1Dialect);

        // Writer A held at the statement that writes the entry, deleter B held at
        // the one that drops the mapping — the points a pair of separate
        // statements on each side can interleave at.
        const holdA = holdAt((text, parameters) => text.startsWith(`INSERT OR REPLACE INTO "${companion}" `) && parameters.includes(target));
        const holdB = holdAt((text, parameters) => text.startsWith(`DELETE FROM "${companion}__ids"`) && parameters.includes(target));
        const patching = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(holdA.gate), schema: schemaFor(table, INDEX) }).patch(target, {
            body: "patched common",
        });

        await holdA.reached;

        const deleting = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(holdB.gate), schema: schemaFor(table, INDEX) }).delete(target);

        await holdB.reached;
        holdA.release();
        await patching;
        holdB.release();
        await deleting;

        // Every entry must be one the map points at, or no later write or purge
        // can ever reach it again.
        const unreachable = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM "${companion}" WHERE "${companion}"."__id__" <> '' AND NOT EXISTS (SELECT 1 FROM "${companion}__ids" WHERE "${companion}__ids"."__rowid__" = "${companion}"."rowid" AND "${companion}__ids"."__id__" = "${companion}"."__id__")`,
        ).first<{ n: number }>();

        expect(unreachable?.n).toBe(0);
        await expect(companionRows(table, target)).resolves.toBe(0);
    });

    /**
     * The layout the previous build left: an FTS5 table with auto rowids, no
     * map, and a finished backfill — plus whatever extra rows `extra` adds.
     */
    const legacyCompanion = async (table: string, body: (n: number) => string, extra: [text: string, id: string][] = []): Promise<void> => {
        const companion = companionOf(table);

        await seed(table, body);
        await env.DB.prepare(`CREATE VIRTUAL TABLE "${companion}" USING fts5("__text__", "__id__" UNINDEXED)`).run();
        await env.DB.prepare(`CREATE VIRTUAL TABLE "${companion}__vocab" USING fts5vocab("${companion}", instance)`).run();
        await env.DB.prepare(
            `INSERT INTO "${companion}" ("__text__", "__id__") SELECT "${table}"."body", "${table}"."id" FROM "${table}" ORDER BY "${table}"."id"`,
        ).run();

        for (const [text, id] of extra) {
            // eslint-disable-next-line no-await-in-loop -- inserted in order, so each lands at a higher rowid
            await env.DB.prepare(`INSERT INTO "${companion}" ("__text__", "__id__") VALUES (?, ?)`).bind(text, id).run();
        }

        await migrateSearchState(d1Exec(), d1Dialect);
        await writeSearchBackfillState(d1Exec(), d1Dialect, companion, pad(ROWS - 1), true, companionProfile(INDEX, d1Dialect));
    };

    it("migrates a companion built before the rowid map, and serves throughout", async () => {
        expect.assertions(7);

        const table = "legacy_docs";

        await legacyCompanion(table, (n) => (n === 5 || n === 10 ? "apple common" : `other${String(n)} common`));
        await runSqlSearchMigrations(d1Exec(), schemaFor(table, INDEX), d1Dialect);

        await expect(companionRows(table)).resolves.toBe(ROWS);
        await expect(distinctIndexed(table)).resolves.toBe(ROWS);
        await expect(search(table, "apple")).resolves.toStrictEqual([pad(5), pad(10)]);

        const writer = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(), schema: schemaFor(table, INDEX) });

        await writer.patch(pad(10), { body: "banana common" });
        await writer.delete(pad(20));

        await expect(companionRows(table, pad(10))).resolves.toBe(1);
        await expect(companionRows(table, pad(20))).resolves.toBe(0);
        await expect(search(table, "apple")).resolves.toStrictEqual([pad(5)]);
        await expect(search(table, "banana")).resolves.toStrictEqual([pad(10)]);
    });

    it("repairs a legacy duplicate from the source row, even when the newer duplicate is the stale one", async () => {
        expect.assertions(4);

        // A backfill that read v1 raced a v2 write and inserted last, so the
        // HIGHER rowid holds the stale text. Keeping the newest row keeps it.
        const table = "legacy_stale_dup";

        await legacyCompanion(table, (n) => (n === 10 ? "freshword common" : `other${String(n)} common`), [["staleword common", pad(10)]]);
        // The duplicate sits past the first bounded page, so it takes the whole walk.
        await backfillSqlSearchIndexes(d1Exec(), schemaFor(table, INDEX), d1Dialect);

        await expect(search(table, "staleword")).resolves.toStrictEqual([]);
        await expect(search(table, "freshword")).resolves.toStrictEqual([pad(10)]);
        await expect(companionRows(table, pad(10))).resolves.toBe(1);
        await expect(companionRows(table)).resolves.toBe(ROWS);
    });

    it("does not hand a new document a legacy row's rowid when a cold start died mid-migration", async () => {
        expect.assertions(4);

        // The cold start that created the map died before it adopted anything:
        // the map exists, and every legacy row is still unknown to it.
        const table = "legacy_interrupted";
        const companion = companionOf(table);

        await legacyCompanion(table, (n) => (n === 0 ? "apple common" : `other${String(n)} common`));
        await env.DB.prepare(`CREATE TABLE "${companion}__ids" ("__rowid__" INTEGER PRIMARY KEY, "__id__" TEXT NOT NULL UNIQUE)`).run();

        const writer = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(), schema: schemaFor(table, INDEX) });

        await writer.insert(table, { _id: "z_new", body: "zebra common", title: "t" }, { allowExplicitId: true });

        await expect(search(table, "apple")).resolves.toStrictEqual([pad(0)]);
        await expect(search(table, "zebra")).resolves.toStrictEqual(["z_new"]);
        await expect(companionRows(table)).resolves.toBe(ROWS + 1);
        await expect(distinctIndexed(table)).resolves.toBe(ROWS + 1);
    });

    it("converges when two cold starts migrate the same legacy companion at once", async () => {
        expect.assertions(4);

        const table = "legacy_overlap";
        const companion = companionOf(table);

        await legacyCompanion(table, (n) => (n === 0 ? "apple common" : `other${String(n)} common`));

        // A is held at its first statement that touches the new map; B runs its
        // whole cold start and writes a new document meanwhile.
        const hold = holdAt((text) => text.includes(`"${companion}__ids"`) && !text.startsWith("CREATE") && !text.startsWith("SELECT name"));
        const isolateA = runSqlSearchMigrations(d1Exec(hold.gate), schemaFor(table, INDEX), d1Dialect);

        await hold.reached;

        const isolateB = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(), schema: schemaFor(table, INDEX) });

        await isolateB.insert(table, { _id: "z_new", body: "zebra common", title: "t" }, { allowExplicitId: true });
        hold.release();
        await isolateA;

        await expect(search(table, "apple")).resolves.toStrictEqual([pad(0)]);
        await expect(search(table, "zebra")).resolves.toStrictEqual(["z_new"]);
        await expect(companionRows(table)).resolves.toBe(ROWS + 1);
        await expect(distinctIndexed(table)).resolves.toBe(ROWS + 1);
    });

    it("stays correct while isolates still running the previous build write during the rollout", async () => {
        expect.assertions(6);

        const table = "rollout";
        const companion = companionOf(table);

        await legacyCompanion(table, (n) => `other${String(n)} common`);
        await runSqlSearchMigrations(d1Exec(), schemaFor(table, INDEX), d1Dialect);

        // What the previous build does on a write: purge by `__id__`, insert at
        // an FTS5-assigned rowid the map has never seen.
        const previousBuildWrite = async (id: string, text: string): Promise<void> => {
            await env.DB.prepare(`UPDATE "${table}" SET "body" = ? WHERE "id" = ?`).bind(text, id).run();
            await env.DB.prepare(`DELETE FROM "${companion}" WHERE "__id__" = ?`).bind(id).run();
            await env.DB.prepare(`INSERT INTO "${companion}" ("__text__", "__id__") VALUES (?, ?)`).bind(text, id).run();
        };

        await previousBuildWrite(pad(7), "oldbuild common");

        const writer = createSqlCtxDb({ clock: CLOCK, dialect: d1Dialect, exec: d1Exec(), schema: schemaFor(table, INDEX) });

        // A new document right after: its entry must not land on the row above.
        await writer.insert(table, { _id: "z_new", body: "zebra common", title: "t" }, { allowExplicitId: true });

        await expect(search(table, "oldbuild")).resolves.toStrictEqual([pad(7)]);
        await expect(search(table, "zebra")).resolves.toStrictEqual(["z_new"]);

        // And the current build rewriting that document drops the previous
        // build's row, as the previous build's own purge-by-id would have.
        await writer.patch(pad(7), { body: "fresh common" });

        await expect(search(table, "oldbuild")).resolves.toStrictEqual([]);
        await expect(search(table, "fresh")).resolves.toStrictEqual([pad(7)]);
        await expect(companionRows(table, pad(7))).resolves.toBe(1);
        await expect(companionRows(table)).resolves.toBe(ROWS + 1);
    });

    it("migrates a large companion a bounded page per cold start", async () => {
        expect.assertions(3);

        const table = "legacy_large";
        const companion = companionOf(table);
        // Rows the previous build left that no current-build write has touched yet.
        const unmigrated = async (): Promise<number> => {
            const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${companion}" WHERE "${companion}"."rowid" > 0`).first<{ n: number }>();

            return row?.n ?? -1;
        };

        await legacyCompanion(table, (n) => `other${String(n)} common`);

        const before = await unmigrated();

        await runSqlSearchMigrations(d1Exec(), schemaFor(table, INDEX), d1Dialect);

        const afterOne = await unmigrated();

        await backfillSqlSearchIndexes(d1Exec(), schemaFor(table, INDEX), d1Dialect);

        expect(before).toBe(ROWS);
        // One cold start moves one bounded page, and leaves the rest for later.
        expect(afterOne).toBeGreaterThan(0);
        await expect(unmigrated()).resolves.toBe(0);
    });
});
