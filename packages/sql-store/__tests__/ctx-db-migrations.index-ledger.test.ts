import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../src/ctx-db";
import type { SqlCtxExec } from "../src/sql-exec";
import { createSqliteBatchHarness, createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * Which indexes a `.global()` migration may drop is decided by a persisted ledger of the indexes the framework created,
 * not by the shape of their name and SQL: an index added by hand is never in it. Run against both provisioning routes,
 * since the batched one plans from the catalog and has to hand a table with a stale index to the sequential route.
 */
const LEDGER = "__lunora_framework_indexes";
const dialect = makeSqliteDialect();

const column = (kind: string, extra: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...extra } }, kind };
};

const global = (
    tableName: string,
    shape: Record<string, ValidatorLike>,
    indexes: { fields: string[]; name: string; unique?: boolean }[] = [],
    rankIndexes: unknown[] = [],
): SchemaLike => ({ tables: { [tableName]: { indexes, rankIndexes, shape, shardMode: { kind: "global" } } } }) as never;

const plain = global("notes", { slug: column("string") });
const withIndex = (name: string): SchemaLike => global("notes", { slug: column("string") }, [{ fields: ["slug"], name, unique: false }]);

interface Harness {
    close: () => void;
    exec: SqlCtxExec;
}

const routes: [string, () => Harness][] = [
    ["statement by statement", createSqliteHarness],
    ["batched", createSqliteBatchHarness],
];

let harness: Harness;

const migrate = async (schema: SchemaLike, tableName = "notes"): Promise<ReturnType<typeof createSqlCtxDb>> => {
    const writer = createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema });

    await writer.findMany(tableName, { limit: 1 });

    return writer;
};

const indexNames = async (tableName = "notes"): Promise<string[]> => {
    const rows = await harness.exec.all(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${tableName}' COLLATE NOCASE AND sql IS NOT NULL ORDER BY name`,
        [],
    );

    return rows.map((row) => String(row["name"]));
};

describe.each(routes)("global framework index ownership (%s)", (_route, makeHarness) => {
    beforeEach(() => {
        harness = makeHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("keeps a hand-created index even when it is unique and named like a framework one", async () => {
        expect.assertions(3);

        await migrate(withIndex("by_slug"));
        await harness.exec.run(`CREATE UNIQUE INDEX "notes_by_hand" ON "notes" ("slug")`, []);
        await migrate(plain);

        await expect(indexNames()).resolves.toContain("notes_by_hand");
        await expect(indexNames()).resolves.not.toContain("notes_by_slug");

        const ledger = await harness.exec.all(`SELECT name FROM "${LEDGER}"`, []);

        expect(ledger.map((row) => row["name"])).not.toContain("notes_by_hand");
    });

    it("records the indexes it creates and forgets one it drops", async () => {
        expect.assertions(2);

        await migrate(withIndex("by_slug"));

        await expect(harness.exec.all(`SELECT name, table_name FROM "${LEDGER}"`, [])).resolves.toEqual([{ name: "notes_by_slug", table_name: "notes" }]);

        await migrate(plain);

        await expect(harness.exec.all(`SELECT name FROM "${LEDGER}"`, [])).resolves.toEqual([]);
    });

    it("drops a stale framework index on the first migration of a database that predates the ledger", async () => {
        expect.assertions(4);

        await migrate(withIndex("by_slug"));
        await harness.exec.run(`DROP TABLE IF EXISTS "${LEDGER}"`, []);
        await migrate(plain);

        await expect(indexNames()).resolves.not.toContain("notes_by_slug");
        await expect(indexNames()).resolves.toContain("notes__by_creation");

        // From then on only the ledger decides.
        await harness.exec.run(`CREATE UNIQUE INDEX "notes_by_hand" ON "notes" ("slug")`, []);
        await migrate(plain);

        await expect(indexNames()).resolves.toContain("notes_by_hand");
        await expect(harness.exec.all(`SELECT 1 FROM sqlite_master WHERE name = '${LEDGER}'`, [])).resolves.toHaveLength(1);
    });

    it("treats an index renamed from `ä` to `Ä` as a rename, since SQLite folds ASCII case only", async () => {
        expect.assertions(2);

        await migrate(withIndex("by_ä"));
        await migrate(withIndex("by_Ä"));

        await expect(indexNames()).resolves.toContain("notes_by_Ä");
        await expect(indexNames()).resolves.not.toContain("notes_by_ä");
    });

    it("drops a unique index after the table name changed only in case", async () => {
        expect.assertions(2);

        await migrate(global("notes", { slug: column("string", { unique: true }) }));

        const writer = await migrate(global("Notes", { slug: column("string") }), "Notes");

        await expect(indexNames().then((names) => names.filter((name) => name.endsWith("_unique_slug")))).resolves.toStrictEqual([]);

        await writer.insert("Notes", { slug: "dup" });

        await expect(writer.insert("Notes", { slug: "dup" })).resolves.toBeTypeOf("string");
    });

    it("rebuilds a unique index that gained a column after the table name changed only in case", async () => {
        expect.assertions(2);

        const shape = { body: column("string"), slug: column("string") };

        await migrate(global("notes", shape, [{ fields: ["slug"], name: "by_slug", unique: true }]));

        const writer = await migrate(global("Notes", shape, [{ fields: ["slug", "body"], name: "by_slug", unique: true }]), "Notes");

        await writer.insert("Notes", { body: "one", slug: "dup" });

        // Unique over (slug, body) now: the same slug with another body is fine.
        await expect(writer.insert("Notes", { body: "two", slug: "dup" })).resolves.toBeTypeOf("string");
        await expect(writer.insert("Notes", { body: "two", slug: "dup" })).rejects.toThrow(/unique/iu);
    });

    it("drops a unique index declared on `_creationTime` once the declaration is removed", async () => {
        expect.assertions(2);

        await migrate(global("notes", { slug: column("string") }, [{ fields: ["_creationTime"], name: "by_time", unique: true }]));

        const writer = await migrate(plain);

        await expect(indexNames()).resolves.not.toContain("notes_by_time");

        await writer.insert("notes", { slug: "a" });

        await expect(writer.insert("notes", { slug: "b" })).resolves.toBeTypeOf("string");
    });
});
