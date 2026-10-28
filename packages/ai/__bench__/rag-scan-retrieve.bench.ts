import { DatabaseSync } from "node:sqlite";

import { bench, describe } from "vitest";

import { cosineSimilarity } from "../src/rag/sql";
import { sqliteVectorStore } from "../src/rag/sqlite-vector-store";

/*
 * The exact-scan `retrieve()` path at a realistic embedding width: every row in
 * the namespace is decoded and scored, so the per-row cost is what scales.
 */
const COUNT = 2000;
const DIMENSIONS = 768;

const vectorOf = (seed: number): number[] => Array.from({ length: DIMENSIONS }, (_, index) => Math.sin(seed * 0.37 + index));

const database = new DatabaseSync(":memory:");
const store = sqliteVectorStore({ exec: (sql, parameters) => database.prepare(sql).all(...(parameters as never[])) });

for (let index = 0; index < COUNT; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- fixture setup; the plain store has no batch upsert
    await store.upsert({ embed: async () => vectorOf(index), id: `v${String(index)}`, input: "v", metadata: { tenant: `t${String(index % 10)}` } });
}

const queryVector = vectorOf(-1);
const query = { embed: async () => queryVector, input: "q", topK: 10 };
const stored = Array.from({ length: COUNT }, (_, index) => vectorOf(index));

describe(`rag exact scan, ${String(COUNT)} x ${String(DIMENSIONS)}-dim vectors`, () => {
    bench("query", async () => {
        await store.query(query);
    });

    bench("cosineSimilarity only", () => {
        for (const vector of stored) {
            cosineSimilarity(queryVector, vector);
        }
    });
});
