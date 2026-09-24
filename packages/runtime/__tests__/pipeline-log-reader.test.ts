import { createR2Sql } from "@lunora/bindings/r2sql";
import { describe, expect, it } from "vitest";

import type { PipelineLogQuery, PipelineLogReaderOptions, PipelineLogRow } from "../src/pipeline-log-reader";
import { createPipelineLogReader } from "../src/pipeline-log-reader";

/** Captures the SQL text the reader sends and returns caller-supplied rows. */
interface Capture {
    statement: string;
}

/**
 * Build a reader over an injected `fetch` double so no query touches the network.
 * `rows` are echoed back as the R2 SQL envelope; the sent statement is captured.
 */
const makeReader = (
    rows: Record<string, unknown>[],
    options?: PipelineLogReaderOptions,
): { capture: Capture; reader: ReturnType<typeof createPipelineLogReader> } => {
    const capture: Capture = { statement: "" };

    const fetch: typeof globalThis.fetch = async (_url, init) => {
        const body = (init?.body as string | undefined) ?? "{}";

        capture.statement = (JSON.parse(body) as { query: string }).query;

        return Response.json({ result: { rows }, success: true }, { status: 200 });
    };

    const client = createR2Sql({ accountId: "acc", apiToken: "tok", bucket: "bkt", fetch });

    return { capture, reader: createPipelineLogReader(client, options ?? { table: "logs" }) };
};

/** One stored record keyed by the default (identity) column names. */
const rowAt = (ts: number): Record<string, unknown> => {
    return {
        fields: null,
        functionPath: "messages:list",
        level: "info",
        message: "hello",
        shardKey: null,
        spanId: null,
        traceId: null,
        ts,
        userId: null,
    };
};

/**
 * A stored record with a distinct `message` — so its identity hash is unique even
 * when many rows share one `ts` (the dedup relies on distinguishable rows).
 */
const rowMsg = (ts: number, message: string): Record<string, unknown> => {
    return { fields: null, functionPath: "messages:list", level: "info", message, shardKey: null, spanId: null, traceId: null, ts, userId: null };
};

/**
 * A reader over a `fetch` double that actually HONORS the query — it parses the
 * inclusive keyset bound and the row limit out of the statement and returns the
 * matching prefix of a fixed, `ts DESC` dataset. This models a real engine closely
 * enough to page it to exhaustion (the simple echo `makeReader` ignores the
 * predicate, so it cannot round-trip pagination).
 */
const makePagingReader = (dataset: Record<string, unknown>[]): ReturnType<typeof createPipelineLogReader> => {
    const fetch: typeof globalThis.fetch = async (_url, init) => {
        const body = (init?.body as string | undefined) ?? "{}";
        const statement = (JSON.parse(body) as { query: string }).query;

        const limitMatch = /LIMIT (\d+)/.exec(statement);
        const limit = limitMatch ? Number(limitMatch[1]) : dataset.length;

        const boundMatch = /ts <= (\d+)/.exec(statement);
        const bounded = boundMatch ? dataset.filter((row) => Number(row.ts) <= Number(boundMatch[1])) : dataset;

        return Response.json({ result: { rows: bounded.slice(0, limit) }, success: true }, { status: 200 });
    };

    const client = createR2Sql({ accountId: "acc", apiToken: "tok", bucket: "bkt", fetch });

    return createPipelineLogReader(client, { table: "logs" });
};

/** Page a reader to exhaustion, concatenating every page's rows. Throws rather than hang if pagination never terminates. */
const drain = async (reader: ReturnType<typeof createPipelineLogReader>, query: PipelineLogQuery): Promise<PipelineLogRow[]> => {
    const collected: PipelineLogRow[] = [];
    let cursor: PipelineLogQuery["cursor"];

    for (let guard = 0; guard < 1000; guard += 1) {
        // eslint-disable-next-line no-await-in-loop -- paging is inherently sequential: each request needs the prior page's cursor
        const page = await reader.query({ ...query, cursor });

        collected.push(...page.rows);

        if (page.nextCursor === undefined) {
            return collected;
        }

        cursor = page.nextCursor;
    }

    throw new Error("drain: pagination did not terminate");
};

describe("createPipelineLogReader", () => {
    it("renders an inclusive time range, ts-DESC order, and the over-fetched default limit", async () => {
        expect.assertions(4);

        const { capture, reader } = makeReader([]);

        await reader.query({ sinceTs: 1000, untilTs: 2000 });

        expect(capture.statement).toContain("ts >= 1000");
        expect(capture.statement).toContain("ts <= 2000");
        expect(capture.statement).toContain("ORDER BY ts DESC");
        // Default limit 500, over-fetched by one for keyset overflow detection.
        expect(capture.statement).toContain("LIMIT 501");
    });

    it("renders an exact level equality when `level` is set", async () => {
        expect.assertions(2);

        const { capture, reader } = makeReader([]);

        await reader.query({ level: "error" });

        expect(capture.statement).toContain("level = 'error'");
        // Exact level wins: no `IN (...)` expansion is emitted alongside it.
        expect(capture.statement).not.toContain("IN (");
    });

    it("expands `minLevel` to the closed set at/above the floor in severity order", async () => {
        expect.assertions(2);

        const { capture, reader } = makeReader([]);

        await reader.query({ minLevel: "warn" });

        expect(capture.statement).toContain("level IN ('warn', 'error', 'fatal')");
        expect(capture.statement).not.toContain("'info'");
    });

    it("prefers an exact `level` over `minLevel` when both are given", async () => {
        expect.assertions(2);

        const { capture, reader } = makeReader([]);

        await reader.query({ level: "error", minLevel: "trace" });

        expect(capture.statement).toContain("level = 'error'");
        expect(capture.statement).not.toContain("IN (");
    });

    it("renders `functionPathPrefix` as a LIKE with the wildcard inside the escaped literal", async () => {
        expect.assertions(1);

        const { capture, reader } = makeReader([]);

        await reader.query({ functionPathPrefix: "messages:" });

        expect(capture.statement).toContain("functionPath LIKE 'messages:%'");
    });

    it("combines the exact traceId / shardKey / userId filters with AND", async () => {
        expect.assertions(3);

        const { capture, reader } = makeReader([]);

        await reader.query({ shardKey: "channel-1", traceId: "abc", userId: "u1" });

        expect(capture.statement).toContain("traceId = 'abc'");
        expect(capture.statement).toContain("shardKey = 'channel-1'");
        expect(capture.statement).toContain("userId = 'u1'");
    });

    it("escapes a single quote in a filter value so it cannot break out of the literal", async () => {
        expect.assertions(1);

        const { capture, reader } = makeReader([]);

        await reader.query({ shardKey: "o'brien" });

        // Doubled quote — the value stays inside its literal (no injection).
        expect(capture.statement).toContain("shardKey = 'o''brien'");
    });

    it("clamps an over-large limit down to the engine ceiling", async () => {
        expect.assertions(1);

        const { capture, reader } = makeReader([]);

        await reader.query({ limit: 999_999 });

        // Clamped to 10000; the +1 over-fetch would trip the engine, so it is capped.
        expect(capture.statement).toContain("LIMIT 10000");
    });

    it("clamps a below-range limit up to 1 (then over-fetches by one)", async () => {
        expect.assertions(1);

        const { capture, reader } = makeReader([]);

        await reader.query({ limit: 0 });

        expect(capture.statement).toContain("LIMIT 2");
    });

    it("mints the keyset cursor from the last RETURNED row (not the overflow row) and records its boundary hash", async () => {
        expect.assertions(5);

        // Three rows for a limit of two → the third is the overflow that only
        // proves a next page exists; the cursor rides the last returned row (ts 200).
        const { reader } = makeReader([rowAt(300), rowAt(200), rowAt(100)]);

        const page = await reader.query({ limit: 2 });

        expect(page.rows).toHaveLength(2);
        expect(page.rows[0]?.ts).toBe(300);
        expect(page.rows[1]?.ts).toBe(200);
        // Cursor ts is the last returned row (200), so the inclusive resume re-reads
        // that millisecond and cannot skip a tied row the overflow-cursor would drop.
        expect(page.nextCursor?.ts).toBe(200);
        // The boundary row (ts 200) is carried by hash so the next page drops it.
        expect(page.nextCursor?.seen).toHaveLength(1);
    });

    it("omits the cursor when the result does not overflow the page", async () => {
        expect.assertions(2);

        const { reader } = makeReader([rowAt(300), rowAt(200)]);

        const page = await reader.query({ limit: 2 });

        expect(page.rows).toHaveLength(2);
        expect(page.nextCursor).toBeUndefined();
    });

    it("resumes inclusively (<=) at a supplied cursor ts so tied rows are not skipped", async () => {
        expect.assertions(2);

        const { capture, reader } = makeReader([]);

        await reader.query({ cursor: { seen: ["abc"], ts: 100 } });

        expect(capture.statement).toContain("ts <= 100");
        // The old exclusive `< 100` predicate is exactly the row-loss bug this fixes.
        expect(capture.statement).not.toContain("ts < 100");
    });

    it("remaps every clause to the operator's columns via columnMap", async () => {
        expect.assertions(5);

        const { capture, reader } = makeReader([], {
            columnMap: { functionPath: "fn", level: "lvl", ts: "event_ts" },
            namespace: "logs_ns",
            table: "app_logs",
        });

        await reader.query({ level: "error", minLevel: "warn", sinceTs: 10 });

        expect(capture.statement).toContain("FROM logs_ns.app_logs");
        expect(capture.statement).toContain("event_ts >= 10");
        expect(capture.statement).toContain("lvl = 'error'");
        expect(capture.statement).toContain("ORDER BY event_ts DESC");
        // Default-named columns still appear in the projection for unmapped fields.
        expect(capture.statement).toContain("message");
    });

    it("decodes a remapped row back to the canonical PipelineLogRow shape", async () => {
        expect.assertions(3);

        const { reader } = makeReader([{ event_ts: 500, fn: "orders:checkout", lvl: "warn", message: "slow" }], {
            columnMap: { functionPath: "fn", level: "lvl", ts: "event_ts" },
            table: "app_logs",
        });

        const page = await reader.query();

        expect(page.rows[0]?.functionPath).toBe("orders:checkout");
        expect(page.rows[0]?.level).toBe("warn");
        expect(page.rows[0]?.ts).toBe(500);
    });

    it("parses a JSON-string `fields` column (the serializeFields shape) back to an object", async () => {
        expect.assertions(1);

        const { reader } = makeReader([{ ...rowAt(700), fields: JSON.stringify({ orderId: 7 }) }]);

        const page = await reader.query();

        expect(page.rows[0]?.fields).toStrictEqual({ orderId: 7 });
    });

    it("leaves optional columns off the row when the record stored no value", async () => {
        expect.assertions(2);

        const { reader } = makeReader([rowAt(800)]);

        const page = await reader.query();

        // `rowAt` stores null for shardKey/userId/traceId/spanId/fields.
        expect(page.rows[0]).not.toHaveProperty("shardKey");
        expect(page.rows[0]).not.toHaveProperty("traceId");
    });

    it("combines all filters as AND-ed conditions in one statement", async () => {
        expect.assertions(1);

        const { capture, reader } = makeReader([]);

        const query: PipelineLogQuery = { functionPathPrefix: "m:", shardKey: "s", sinceTs: 1, untilTs: 9 };

        await reader.query(query);

        // Each fragment is parenthesised: `SelectBuilder` wraps every `.where()`
        // fragment so a condition containing `OR` cannot bind looser than the
        // `AND` that joins them.
        expect(capture.statement).toContain("WHERE (ts >= 1) AND (ts <= 9) AND (functionPath LIKE 'm:%') AND (shardKey = 's')");
    });

    it("pages a duplicate-ts dataset to exhaustion losslessly — the union of all pages equals the full result, no gaps, no dupes", async () => {
        expect.assertions(4);

        // 25 rows, ts DESC, with ties (ts 400 ×10, 300 ×6, 200 ×5) engineered so the
        // limit-10 page boundaries land *inside* a tie — exactly where the old
        // exclusive `< cursor.ts` cursor dropped every co-millisecond row.
        const dataset: Record<string, unknown>[] = [];
        let id = 0;
        const push = (ts: number, count: number): void => {
            for (let index = 0; index < count; index += 1) {
                dataset.push(rowMsg(ts, `m${String(id)}`));
                id += 1;
            }
        };

        push(500, 1);
        push(490, 1);
        push(480, 1);
        push(470, 1);
        push(400, 10);
        push(300, 6);
        push(200, 5);

        const reader = makePagingReader(dataset);

        // The full unpaged result: one query large enough to return everything.
        const full = await reader.query({ limit: 100 });
        const paged = await drain(reader, { limit: 10 });

        const fullKeys = full.rows.map((row) => `${String(row.ts)}:${row.message}`);
        const pagedKeys = paged.map((row) => `${String(row.ts)}:${row.message}`);

        // Every row exactly once, in the same order, with nothing lost or repeated.
        expect(full.rows).toHaveLength(25);
        expect(paged).toHaveLength(25);
        expect(new Set(pagedKeys).size).toBe(25);
        expect(pagedKeys).toStrictEqual(fullKeys);
    });

    it("terminates and returns every row exactly once when a whole page shares one ts (degenerate tie)", async () => {
        expect.assertions(2);

        // 15 rows all at ts 100 with a limit of 10: the boundary can never advance by
        // `ts` alone, so the reader must grow its fetch window and dedup by hash to
        // finish. Distinct messages keep the 15 rows individually identifiable.
        const dataset: Record<string, unknown>[] = [];
        for (let index = 0; index < 15; index += 1) {
            dataset.push(rowMsg(100, `d${String(index)}`));
        }

        const reader = makePagingReader(dataset);

        const collected = await drain(reader, { limit: 10 });

        expect(collected).toHaveLength(15);
        expect(new Set(collected.map((row) => row.message)).size).toBe(15);
    });
});
