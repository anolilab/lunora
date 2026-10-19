import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../src/ctx-db";
import type { SqlCtxExec } from "../src/sql-exec";
import { createSqliteBatchHarness, createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * The `.global()` (D1) twin of the shard migrations that follow a schema edit: an index the schema no longer
 * declares is dropped, and a rank companion whose `sortBy` changed is reshaped. `CREATE ... IF NOT EXISTS` only ever
 * adds, so a `.unique()` taken off a column kept rejecting duplicates and a `sortBy` that gained a key left the
 * companion without the column its rebuild writes to.
 *
 * Run against both provisioning routes: an exec with no `batch` provisions statement by statement, one with `batch`
 * plans the DDL from the catalog and must hand a table with a stale index to the sequential route.
 */
const dialect = makeSqliteDialect();

const column = (kind: string, extra: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...extra } }, kind };
};

const notes = (
    shape: Record<string, ValidatorLike>,
    indexes: { fields: string[]; name: string; unique?: boolean }[] = [],
    rankIndexes: unknown[] = [],
): SchemaLike => ({ tables: { notes: { indexes, rankIndexes, shape, shardMode: { kind: "global" } } } }) as never;

const uniqueColumn = notes({ slug: column("string", { unique: true }) });
const plainColumn = notes({ slug: column("string") });
const withIndex = (unique: boolean): SchemaLike => notes({ slug: column("string") }, [{ fields: ["slug"], name: "by_slug", unique }]);

interface Harness {
    close: () => void;
    exec: SqlCtxExec;
}

const routes: [string, () => Harness][] = [
    ["statement by statement", createSqliteHarness],
    ["batched", createSqliteBatchHarness],
];

let harness: Harness;

/** A writer over the shared database; its first read provisions `schema`. */
const migrate = async (schema: SchemaLike): Promise<ReturnType<typeof createSqlCtxDb>> => {
    const writer = createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema });

    await writer.findMany("notes", { limit: 1 });

    return writer;
};

const indexNames = async (): Promise<string[]> => {
    const rows = await harness.exec.all(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes' AND sql IS NOT NULL ORDER BY name`, []);

    return rows.map((row) => String(row["name"]));
};

describe.each(routes)("global table migrations (%s) — an index that is no longer declared", (_route, makeHarness) => {
    beforeEach(() => {
        harness = makeHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("drops the unique index when `.unique()` is removed from a column", async () => {
        expect.assertions(3);

        await migrate(uniqueColumn);

        await expect(indexNames()).resolves.toContain("notes_unique_slug");

        const writer = await migrate(plainColumn);

        await expect(indexNames()).resolves.not.toContain("notes_unique_slug");

        await writer.insert("notes", { slug: "dup" });

        await expect(writer.insert("notes", { slug: "dup" })).resolves.toBeTypeOf("string");
    });

    it.each([true, false])("drops a declared index that is removed from the table (unique: %s)", async (unique) => {
        expect.assertions(2);

        await migrate(withIndex(unique));

        await expect(indexNames()).resolves.toContain("notes_by_slug");

        await migrate(plainColumn);

        await expect(indexNames()).resolves.not.toContain("notes_by_slug");
    });

    it("keeps the indexes that are still declared, and ones the framework did not create", async () => {
        expect.assertions(3);

        await migrate(withIndex(false));
        await harness.exec.run(`CREATE INDEX "notes_by_hand" ON "notes" ("_creationTime")`, []);
        await migrate(withIndex(false));

        await expect(indexNames()).resolves.toContain("notes_by_slug");
        await expect(indexNames()).resolves.toContain("notes_by_hand");
        await expect(indexNames()).resolves.toContain("notes__by_creation");
    });
});

const rankedBy = (sortBy: { direction: "asc" | "desc"; field: string }[]): SchemaLike =>
    notes({ name: column("string"), score: column("number") }, [], [{ name: "leaderboard", on: "notes", sortBy }]);

describe.each(routes)("global table migrations (%s) — a rank companion whose sortBy changed", (_route, makeHarness) => {
    beforeEach(() => {
        harness = makeHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("keeps writes working and rebuilds the companion when a sort key is added", async () => {
        expect.assertions(3);

        const before = await migrate(rankedBy([{ direction: "desc", field: "score" }]));

        await before.insert("notes", { _id: "p1", name: "b", score: 10 }, { allowExplicitId: true });
        await before.insert("notes", { _id: "p2", name: "a", score: 10 }, { allowExplicitId: true });

        const widened = await migrate(
            rankedBy([
                { direction: "desc", field: "score" },
                { direction: "asc", field: "name" },
            ]),
        );

        await expect(widened.insert("notes", { _id: "p3", name: "c", score: 30 }, { allowExplicitId: true })).resolves.toBe("p3");

        const page = await widened.rankPage("notes", "leaderboard", { take: 10 });

        expect(page.page.map((row) => row["_id"])).toStrictEqual(["p3", "p2", "p1"]);

        const columns = await harness.exec.all(`SELECT sql FROM sqlite_master WHERE name = 'notes__rank_leaderboard'`, []);

        expect(String(columns[0]?.["sql"])).toContain("__sort_k1__");
    });

    it("keeps writes working when a sort key is removed", async () => {
        expect.assertions(2);

        const before = await migrate(
            rankedBy([
                { direction: "desc", field: "score" },
                { direction: "asc", field: "name" },
            ]),
        );

        await before.insert("notes", { _id: "p1", name: "b", score: 10 }, { allowExplicitId: true });

        const narrowed = await migrate(rankedBy([{ direction: "desc", field: "score" }]));

        await expect(narrowed.insert("notes", { _id: "p2", name: "a", score: 20 }, { allowExplicitId: true })).resolves.toBe("p2");

        const columns = await harness.exec.all(`SELECT sql FROM sqlite_master WHERE name = 'notes__rank_leaderboard'`, []);

        expect(String(columns[0]?.["sql"])).not.toContain("__sort_k1__");
    });

    it("reshapes the sorted btree when only a sort direction changes", async () => {
        expect.assertions(3);

        const before = await migrate(rankedBy([{ direction: "desc", field: "score" }]));

        await before.insert("notes", { _id: "p1", name: "a", score: 10 }, { allowExplicitId: true });
        await before.insert("notes", { _id: "p2", name: "b", score: 30 }, { allowExplicitId: true });

        const flipped = await migrate(rankedBy([{ direction: "asc", field: "score" }]));
        const btree = await harness.exec.all(`SELECT sql FROM sqlite_master WHERE name = 'notes__rank_leaderboard__btree'`, []);

        expect(String(btree[0]?.["sql"])).toContain(`"__sort_k0__" ASC`);

        const page = await flipped.rankPage("notes", "leaderboard", { take: 10 });

        expect(page.page.map((row) => row["_id"])).toStrictEqual(["p1", "p2"]);
        await expect(flipped.insert("notes", { _id: "p3", name: "c", score: 20 }, { allowExplicitId: true })).resolves.toBe("p3");
    });
});
