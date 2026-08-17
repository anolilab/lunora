import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import bm25LexicalStore from "../../src/rag/lexical-store";
import type { RagSqlExec } from "../../src/rag/sql";
import { sqlLexicalStore } from "../../src/rag/sql-lexical-store";
import type { StoredRagChunk } from "../../src/rag/types";

const open = (): { close: () => void; exec: RagSqlExec } => {
    const database = new DatabaseSync(":memory:");

    return {
        close: () => {
            database.close();
        },
        exec: (sql, parameters) => database.prepare(sql).all(...(parameters as never[])),
    };
};

const opened: (() => void)[] = [];

const store = () => {
    const { close, exec } = open();

    opened.push(close);

    return sqlLexicalStore({ exec });
};

const chunk = (id: string, text: string, metadata?: Record<string, unknown>): StoredRagChunk => {
    return { chunkIndex: 0, id, sourceId: id.split("#")[0] as string, text, ...(metadata === undefined ? {} : { metadata }) };
};

describe("sqlLexicalStore", () => {
    afterEach(() => {
        while (opened.length > 0) {
            opened.pop()?.();
        }
    });

    it("indexes and retrieves by keyword", async () => {
        expect.assertions(2);

        const lexical = store();

        await lexical.index([chunk("a#0", "the qwerty token lives here"), chunk("b#0", "unrelated prose about cooking")], {});

        const matches = await lexical.search("qwerty", { topK: 5 });

        expect(matches).toHaveLength(1);
        expect(matches[0]?.text).toBe("the qwerty token lives here");
    });

    it("ranks the same way the in-memory store does", async () => {
        expect.assertions(1);

        const corpus = [
            chunk("a#0", "storm cloud rain thunder storm"),
            chunk("b#0", "storm cloud"),
            chunk("c#0", "sunshine and clear skies"),
            chunk("d#0", "a storm is coming"),
        ];

        const durable = store();
        const memory = bm25LexicalStore();

        await durable.index(corpus, {});
        await memory.index(corpus, {});

        const fromDurable = await durable.search("storm cloud", { topK: 4 });
        const fromMemory = await memory.search("storm cloud", { topK: 4 });

        // Same kernel, same corpus → the ranking must not move when you swap
        // an in-memory store for a durable one.
        expect(fromDurable.map((match) => match.id)).toStrictEqual(fromMemory.map((match) => match.id));
    });

    it("isolates namespaces", async () => {
        expect.assertions(2);

        const lexical = store();

        await lexical.index([chunk("a#0", "tenant alpha secret")], { namespace: "org-a" });
        await lexical.index([chunk("a#0", "tenant beta secret")], { namespace: "org-b" });

        const inA = await lexical.search("secret", { namespace: "org-a", topK: 5 });

        expect(inA).toHaveLength(1);
        expect(inA[0]?.text).toBe("tenant alpha secret");
    });

    it("honours a metadata filter", async () => {
        expect.assertions(2);

        const lexical = store();

        await lexical.index([chunk("a#0", "tenant one secret", { orgId: "org-1" }), chunk("b#0", "tenant two secret", { orgId: "org-2" })], {});

        const matches = await lexical.search("secret", { filter: { orgId: "org-1" }, topK: 5 });

        expect(matches).toHaveLength(1);
        expect(matches[0]?.text).toBe("tenant one secret");
    });

    it("re-indexing replaces rather than duplicates", async () => {
        expect.assertions(2);

        const lexical = store();

        await lexical.index([chunk("a#0", "original storm text")], {});
        await lexical.index([chunk("a#0", "revised cloud text")], {});

        const stale = await lexical.search("storm", { topK: 5 });
        const fresh = await lexical.search("cloud", { topK: 5 });

        expect(stale).toStrictEqual([]);
        expect(fresh).toHaveLength(1);
    });

    it("removes chunks", async () => {
        expect.assertions(1);

        const lexical = store();

        await lexical.index([chunk("a#0", "storm cloud")], {});
        await lexical.remove?.(["a#0"], {});

        await expect(lexical.search("storm", { topK: 5 })).resolves.toStrictEqual([]);
    });

    it("survives a new store instance over the same database", async () => {
        expect.assertions(1);

        const { close, exec } = open();

        opened.push(close);

        await sqlLexicalStore({ exec }).index([chunk("a#0", "durable storm cloud")], {});

        // A fresh instance is what an isolate restart looks like — the whole
        // point of a durable index.
        const matches = await sqlLexicalStore({ exec }).search("storm", { topK: 5 });

        expect(matches).toHaveLength(1);
    });

    it("returns nothing for a query with no usable terms", async () => {
        expect.assertions(1);

        const lexical = store();

        await lexical.index([chunk("a#0", "storm cloud")], {});

        await expect(lexical.search("!!! ???", { topK: 5 })).resolves.toStrictEqual([]);
    });

    it("does not index a token-less chunk", async () => {
        expect.assertions(1);

        const lexical = store();

        await lexical.index([chunk("a#0", "!!!"), chunk("b#0", "storm cloud")], {});

        // The empty chunk must not inflate the corpus statistics.
        await expect(lexical.search("storm", { topK: 5 })).resolves.toHaveLength(1);
    });

    it("indexes and searches non-ASCII text", async () => {
        expect.assertions(4);

        const lexical = store();

        await lexical.index([chunk("de#0", "Schlüsselrotation im Betrieb"), chunk("ja#0", "鍵のローテーション"), chunk("ru#0", "ротация ключей")], {});

        // `/[a-z0-9]+/` tokenised every one of these to NOTHING, both stores
        // skip token-less chunks, and hybrid retrieval then quietly degraded to
        // vector-only with nothing logged.
        await expect(lexical.search("Schlüsselrotation", { topK: 5 })).resolves.toHaveLength(1);
        // CJK is not segmented — an unbroken run is one token, so it matches
        // the run, not a substring of it. Still indexed, where it used to be
        // dropped entirely.
        await expect(lexical.search("鍵のローテーション", { topK: 5 })).resolves.toHaveLength(1);
        await expect(lexical.search("ключей", { topK: 5 })).resolves.toHaveLength(1);

        // Diacritics are folded, so the unaccented spelling still finds it.
        await expect(lexical.search("Schlusselrotation", { topK: 5 })).resolves.toHaveLength(1);
    });

    it("ranks identically to the in-memory store on non-ASCII text", async () => {
        expect.assertions(1);

        const lexical = store();
        const memory = bm25LexicalStore();
        const chunks = [chunk("a#0", "Grüße aus Köln"), chunk("b#0", "Grüße aus Berlin und Köln")];

        await lexical.index(chunks, {});
        await memory.index(chunks, {});

        const [durable, inMemory] = await Promise.all([memory.search("Köln", { topK: 5 }), lexical.search("Köln", { topK: 5 })]);

        expect(durable.map((match) => match.id)).toStrictEqual(inMemory.map((match) => match.id));
    });

    it("reads document bodies only for the hits that survive ranking", async () => {
        expect.assertions(3);

        const { close, exec } = open();
        const bodies: number[] = [];

        opened.push(close);

        const lexical = sqlLexicalStore({
            exec: async (sql, parameters) => {
                const rows = await exec(sql, parameters);

                if (sql.includes("text")) {
                    bodies.push(rows.length);
                }

                return rows;
            },
        });

        // Every document carries the query term, so the posting scan matches
        // all 40. Selecting the body on the join read all 40 into the isolate
        // to rank them and then threw 37 away — the cost scaling with the
        // corpus rather than with `topK`.
        await lexical.index(
            Array.from({ length: 40 }, (_, index) => chunk(`d${String(index)}#0`, `storm cloud number ${String(index)}`)),
            {},
        );

        bodies.length = 0;

        const matches = await lexical.search("storm", { topK: 3 });

        expect(matches).toHaveLength(3);
        expect(matches[0]?.text).toMatch(/^storm cloud number/u);
        expect(bodies).toStrictEqual([3]);
    });

    it("rejects a table name that is not a bare identifier", () => {
        expect.assertions(1);

        const { close, exec } = open();

        opened.push(close);

        expect(() => sqlLexicalStore({ exec, table: "lex; DROP TABLE users--" })).toThrow(/must be a bare SQL identifier/u);
    });

    it("requires an exec function", () => {
        expect.assertions(1);

        // @ts-expect-error -- exercising the runtime guard for JS callers
        expect(() => sqlLexicalStore({})).toThrow(/requires an `exec` function/u);
    });
});
