import { DatabaseSync } from "node:sqlite";

import { load } from "sqlite-vec";
import { bench, describe } from "vitest";

import { sqliteVectorStore } from "../src/rag/sqlite-vector-store";

/*
 * A tenant-scoped `retrieve()` always carries a metadata filter. This compares
 * the filtered query served by the vec0 index (over-fetch, then filter) with
 * the exact scan of the same 5,000-vector namespace.
 */
const COUNT = 5000;

const open = () => {
    const database = new DatabaseSync(":memory:", { allowExtension: true });

    load(database);

    return (sql: string, parameters: ReadonlyArray<unknown>) => database.prepare(sql).all(...(parameters as never[]));
};

const build = async (ann: boolean) => {
    const store = sqliteVectorStore({ ...(ann ? { ann: { dimensions: 3 } } : {}), exec: open() });

    await store.upsertMany?.(
        Array.from({ length: COUNT }, (_, index) => {
            return {
                embed: async () => [Math.sin(index), Math.cos(index * 1.3), Math.sin(index * 0.7)],
                id: `v${String(index)}`,
                input: "v",
                metadata: { tenant: `t${String(index % 10)}` },
            };
        }),
    );

    return store;
};

const indexed = await build(true);
const scanned = await build(false);
const query = { embed: async () => [0.3, 0.8, -0.2], filter: { tenant: "t3" }, input: "q", topK: 5 };

describe("filtered rag retrieval, 5,000 vectors", () => {
    bench("ann over-fetch", async () => {
        await indexed.query(query);
    });

    bench("brute-force scan", async () => {
        await scanned.query(query);
    });
});
