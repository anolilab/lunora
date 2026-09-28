import { DatabaseSync } from "node:sqlite";

import { load } from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";

import type { RagSqlExec } from "../../src/rag/sql";
import { sqliteVectorStore } from "../../src/rag/sqlite-vector-store";

const databases: DatabaseSync[] = [];

/** A `node:sqlite` database with sqlite-vec loaded — what a celld cell with `sqlite_vec` has. */
const open = (options: { vec?: boolean } = {}): { exec: RagSqlExec; statements: string[] } => {
    const database = new DatabaseSync(":memory:", { allowExtension: true });
    const statements: string[] = [];

    if (options.vec !== false) {
        load(database);
    }

    databases.push(database);

    return {
        exec: (sql, parameters) => {
            statements.push(sql);

            return database.prepare(sql).all(...(parameters as never[]));
        },
        statements,
    };
};

const fixed = (vector: number[]) => async (): Promise<number[]> => vector;

const seed = async (store: ReturnType<typeof sqliteVectorStore>): Promise<void> => {
    await store.upsert({ embed: fixed([1, 0, 0]), id: "x", input: "x", metadata: { kind: "a" } });
    await store.upsert({ embed: fixed([0, 1, 0]), id: "y", input: "y", metadata: { kind: "b" } });
    await store.upsert({ embed: fixed([0.7, 0.7, 0]), id: "z", input: "z", metadata: { kind: "b" } });
};

describe("sqliteVectorStore with a vec0 index", () => {
    afterEach(() => {
        while (databases.length > 0) {
            databases.pop()?.close();
        }
    });

    it("answers an unfiltered query from the index with the scan's ranking and scores", async () => {
        expect.assertions(3);

        const indexed = open();
        const scanned = open();
        const annStore = sqliteVectorStore({ ann: { dimensions: 3 }, exec: indexed.exec });
        const scanStore = sqliteVectorStore({ exec: scanned.exec });

        await seed(annStore);
        await seed(scanStore);
        indexed.statements.length = 0;

        const query = { embed: fixed([0.9, 0.1, 0]), input: "q", topK: 2 };
        const fromIndex = await annStore.query(query);
        const fromScan = await scanStore.query(query);

        expect(fromIndex.matches.map((match) => match.id)).toStrictEqual(fromScan.matches.map((match) => match.id));
        expect(fromIndex.matches.map((match) => match.score.toFixed(5))).toStrictEqual(fromScan.matches.map((match) => match.score.toFixed(5)));
        // A KNN lookup, not a read of the whole namespace.
        expect(indexed.statements.some((sql) => sql.includes("MATCH") && sql.includes("lunora_rag_vectors_ann"))).toBe(true);
    });

    it("keeps the exact scan for a filtered query, so a filter cannot shorten the page", async () => {
        expect.assertions(2);

        const { exec, statements } = open();
        const store = sqliteVectorStore({ ann: { dimensions: 3 }, exec });

        await seed(store);
        statements.length = 0;

        const result = await store.query({ embed: fixed([1, 0, 0]), filter: { kind: "b" }, input: "q", topK: 2 });

        expect(result.matches.map((match) => match.id)).toStrictEqual(["z", "y"]);
        expect(statements.some((sql) => sql.includes("MATCH"))).toBe(false);
    });

    it("backfills an index created over an existing table", async () => {
        expect.assertions(1);

        const { exec } = open();

        await seed(sqliteVectorStore({ exec }));

        const result = await sqliteVectorStore({ ann: { dimensions: 3 }, exec }).query({ embed: fixed([0, 1, 0]), input: "q", topK: 1 });

        expect(result.matches.map((match) => match.id)).toStrictEqual(["y"]);
    });

    it("re-indexes, deletes and partitions by namespace", async () => {
        expect.assertions(3);

        const { exec } = open();
        const store = sqliteVectorStore({ ann: { dimensions: 3 }, exec });

        await seed(store);
        await store.upsert({ embed: fixed([1, 0, 0]), id: "x", input: "x", namespace: "other" });
        // Moving `y` next to the query must replace its old vector, not add a second.
        await store.upsert({ embed: fixed([0, 0, 1]), id: "y", input: "y" });
        await store.deleteByIds(["x"]);

        const nearest = await store.query({ embed: fixed([0, 0, 1]), input: "q", topK: 5 });
        const other = await store.query({ embed: fixed([0, 0, 1]), input: "q", namespace: "other", topK: 5 });

        expect(nearest.matches.map((match) => match.id)).toStrictEqual(["y", "z"]);
        expect(nearest.matches[0]?.score).toBeCloseTo(1, 5);
        expect(other.matches.map((match) => match.id)).toStrictEqual(["x"]);
    });

    it("drops an index match whose row the table no longer holds", async () => {
        expect.assertions(1);

        const { exec } = open();
        const store = sqliteVectorStore({ ann: { dimensions: 3 }, exec });

        await seed(store);
        // What an upsert interrupted between its index and table writes leaves.
        await exec("DELETE FROM lunora_rag_vectors WHERE id = ?", ["x"]);

        const result = await store.query({ embed: fixed([1, 0, 0]), input: "q", topK: 3 });

        expect(result.matches.map((match) => match.id)).toStrictEqual(["z", "y"]);
    });

    it("names the missing extension when the SQLite has no vec0", async () => {
        expect.assertions(1);

        const store = sqliteVectorStore({ ann: { dimensions: 3 }, exec: open({ vec: false }).exec });

        await expect(seed(store)).rejects.toThrow(/needs the sqlite-vec extension.*`sqlite_vec` compatibility flag/u);
    });

    it("rejects a non-positive width and publishes the index width as the dimension ceiling", () => {
        expect.assertions(2);

        const { exec } = open();

        expect(() => sqliteVectorStore({ ann: { dimensions: 0 }, exec })).toThrow(/must be a positive integer/u);
        expect(sqliteVectorStore({ ann: { dimensions: 3 }, exec }).capabilities.maxDimensions).toBe(3);
    });
});
