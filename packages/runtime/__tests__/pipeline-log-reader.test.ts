import { createR2Sql } from "@lunora/bindings/r2sql";
import { describe, expect, it } from "vitest";

import type { PipelineLogQuery, PipelineLogReaderOptions } from "../src/pipeline-log-reader";
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

    it("returns a keyset cursor from the (limit + 1)th overflow row", async () => {
        expect.assertions(4);

        // Three rows for a limit of two → one overflow row supplies the cursor.
        const { reader } = makeReader([rowAt(300), rowAt(200), rowAt(100)]);

        const page = await reader.query({ limit: 2 });

        expect(page.rows).toHaveLength(2);
        expect(page.rows[0]?.ts).toBe(300);
        expect(page.rows[1]?.ts).toBe(200);
        // Cursor is the overflow row's ts (rows[limit]).
        expect(page.nextCursor?.ts).toBe(100);
    });

    it("omits the cursor when the result does not overflow the page", async () => {
        expect.assertions(2);

        const { reader } = makeReader([rowAt(300), rowAt(200)]);

        const page = await reader.query({ limit: 2 });

        expect(page.rows).toHaveLength(2);
        expect(page.nextCursor).toBeUndefined();
    });

    it("resumes strictly past a supplied cursor ts", async () => {
        expect.assertions(1);

        const { capture, reader } = makeReader([]);

        await reader.query({ cursor: { ts: 100 } });

        expect(capture.statement).toContain("ts < 100");
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

        expect(capture.statement).toContain("WHERE ts >= 1 AND ts <= 9 AND functionPath LIKE 'm:%' AND shardKey = 's'");
    });
});
