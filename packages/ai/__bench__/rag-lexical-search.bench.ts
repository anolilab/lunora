import { DatabaseSync } from "node:sqlite";

import { bench, describe } from "vitest";

import { sqlLexicalStore } from "../src/rag/sql-lexical-store";

/*
 * A tenant-scoped hybrid `retrieve()` sends its metadata filter to the lexical
 * leg too. A multi-term query against common terms returns one posting row per
 * (term, document), so the per-row work is what scales.
 */
const COUNT = 2000;
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

const database = new DatabaseSync(":memory:");
const store = sqlLexicalStore({ exec: (sql, parameters) => database.prepare(sql).all(...(parameters as never[])) });

await store.index(
    Array.from({ length: COUNT }, (_, index) => {
        return {
            chunkIndex: 0,
            id: `c${String(index)}`,
            metadata: { tags: ["docs", "guide"], tenant: `t${String(index % 4)}`, title: `Document number ${String(index)}` },
            sourceId: `s${String(index)}`,
            text: `${WORDS.join(" ")} unique${String(index)} filler text about the topic`,
        };
    }),
    {},
);

describe(`filtered lexical search, ${String(COUNT)} documents x ${String(WORDS.length)} matching terms`, () => {
    bench("search, tenant filter", async () => {
        await store.search(WORDS.join(" "), { filter: { tenant: "t1" }, topK: 20 });
    });

    bench("search, no filter", async () => {
        await store.search(WORDS.join(" "), { topK: 20 });
    });
});
