/**
 * Workerd's per-statement bound-parameter cap, asserted on the SQL these stores
 * RENDER.
 *
 * `SQLITE_MAX_VARIABLE_NUMBER` is 100 on Durable Object storage and on D1 — the
 * two backends `sqliteVectorStore` and `sqlLexicalStore` target — and exceeding
 * it is a prepare-time `too many SQL variables` failure. `node:sqlite`, which
 * the rest of this suite runs on, is built with the stock 32 766 cap and cannot
 * reproduce it: an integration test would pass on a statement that is certain
 * to fail in production. So these assert the emitted statement instead, the way
 * `packages/shard-engine/__tests__/workerd-sql-limits.test.ts` does.
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { RagSqlExec } from "../../src/rag/sql";
import { sqlLexicalStore } from "../../src/rag/sql-lexical-store";
import { sqliteVectorStore } from "../../src/rag/sqlite-vector-store";
import type { StoredRagChunk } from "../../src/rag/types";

/** Workerd caps bound parameters per statement at this, on both DO storage and D1. */
const WORKERD_MAX_BOUND_PARAMS = 100;

interface Statement {
    parameters: ReadonlyArray<unknown>;
    sql: string;
}

/** A real `node:sqlite` executor that also records every statement it ran. */
const recordingExec = (): { close: () => void; exec: RagSqlExec; statements: Statement[] } => {
    const database = new DatabaseSync(":memory:");
    const statements: Statement[] = [];

    return {
        close: () => {
            database.close();
        },
        exec: (sql, parameters) => {
            statements.push({ parameters, sql });

            return database.prepare(sql).all(...(parameters as never[]));
        },
        statements,
    };
};

/** Every statement binds no more parameters than workerd will prepare, and renders exactly that many placeholders. */
const expectWithinCap = (statements: ReadonlyArray<Statement>): void => {
    for (const statement of statements) {
        expect(statement.parameters.length).toBeLessThanOrEqual(WORKERD_MAX_BOUND_PARAMS);
        expect(statement.sql.split("?").length - 1).toBe(statement.parameters.length);
    }
};

const ids = (count: number, prefix = "doc"): string[] => Array.from({ length: count }, (_, index) => `${prefix}#${String(index)}`);

const embed = (): ReadonlyArray<number> => [0.1, 0.2, 0.3];

describe("sqliteVectorStore stays under workerd's bound-parameter cap", () => {
    it("batches deleteByIds over a source with more chunks than the cap", async () => {
        expect.assertions(7);

        const { close, exec, statements } = recordingExec();
        const store = sqliteVectorStore({ exec });
        // ~125 chunks is a 100 KB document at the default chunkSize/overlap, so
        // this is the ordinary size of a `remove()`, not a pathological one.
        const removed = ids(150);

        await store.deleteByIds(removed);
        close();

        const deletes = statements.filter((statement) => statement.sql.startsWith("DELETE"));

        expectWithinCap(deletes);

        expect(deletes.flatMap((statement) => statement.parameters.slice(1))).toStrictEqual(removed);
    });

    it("batches getByIds over a candidate pool wider than the cap", async () => {
        expect.assertions(8);

        const { close, exec, statements } = recordingExec();
        const store = sqliteVectorStore({ exec });

        await store.upsert({ embed, id: "doc#0", input: "x" });

        const requested = ids(150);
        const records = await store.getByIds(requested);

        close();

        const selects = statements.filter((statement) => statement.sql.includes("id IN ("));

        expectWithinCap(selects);

        expect(selects.flatMap((statement) => statement.parameters.slice(1))).toStrictEqual(requested);
        // Batching must not change the answer: the one stored id still comes back.
        expect(records.map((record) => record.id)).toStrictEqual(["doc#0"]);
    });
});

describe("sqlLexicalStore stays under workerd's bound-parameter cap", () => {
    const chunk = (id: string, text: string): StoredRagChunk => {
        return { chunkIndex: 0, id, sourceId: "doc", text };
    };

    it("batches the delete pair a re-index issues", async () => {
        expect.assertions(16);

        const { close, exec, statements } = recordingExec();
        const store = sqlLexicalStore({ exec });

        await store.remove?.(ids(200), {});
        close();

        expectWithinCap(statements.filter((statement) => statement.sql.startsWith("DELETE")));
    });

    it("inserts postings in multi-row batches rather than one statement per term", async () => {
        expect.assertions(41);

        const { close, exec, statements } = recordingExec();
        const store = sqlLexicalStore({ exec });
        // 300 distinct terms in one chunk — a paragraph of prose reaches this.
        const text = Array.from({ length: 300 }, (_, index) => `term${String(index)}`).join(" ");

        await store.index([chunk("doc#0", text)], {});
        close();

        const inserts = statements.filter((statement) => statement.sql.startsWith("INSERT"));

        expectWithinCap(inserts);

        // One statement per (chunk × term) was the shape this replaces; on D1
        // each is a round trip against the Worker's subrequest budget.
        expect(inserts.length).toBeLessThan(30);
    });

    it("batches the postings join when a query has more distinct terms than the cap", async () => {
        expect.assertions(8);

        const { close, exec, statements } = recordingExec();
        const store = sqlLexicalStore({ exec });

        await store.index([chunk("doc#0", "alpha bravo charlie")], {});

        const before = statements.length;
        const query = Array.from({ length: 150 }, (_, index) => `word${String(index)}`).join(" ");
        const matches = await store.search(query, { topK: 5 });

        close();

        const joins = statements.slice(before).filter((statement) => statement.sql.includes("t.term IN ("));

        expectWithinCap(joins);

        expect(joins.length).toBeGreaterThan(1);
        expect(matches).toStrictEqual([]);
    });
});
