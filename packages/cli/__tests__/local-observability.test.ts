import { formatLunoraEvent } from "@lunora/config";
import { describe, expect, it, vi } from "vitest";

import {
    buildLocalLogQuery,
    DEFAULT_LOCAL_LOG_LIMIT,
    LocalObservabilityError,
    mapLocalLogRows,
    MAX_LOCAL_LOG_LIMIT,
    parseTimeBound,
    queryLocalObservability,
    readLocalLogs,
    unwrapConsoleMessage,
} from "../src/util/local-observability";

describe(buildLocalLogQuery, () => {
    it("reads the newest lines by default", () => {
        expect.assertions(3);

        const sql = buildLocalLogQuery();

        expect(sql).toContain("FROM logs");
        expect(sql).toContain("ORDER BY ts_ms DESC, seq DESC");
        expect(sql).toContain(`LIMIT ${String(DEFAULT_LOCAL_LOG_LIMIT)}`);
    });

    it("omits the WHERE clause entirely when nothing is filtered", () => {
        expect.assertions(1);

        expect(buildLocalLogQuery()).not.toContain("WHERE");
    });

    it("applies only the filters the caller set", () => {
        expect.assertions(4);

        const sql = buildLocalLogQuery({ level: "error", sinceMs: 1_700_000_000_000, traceId: "abc123" });

        expect(sql).toContain("level = 'error'");
        expect(sql).toContain("trace_id = 'abc123'");
        expect(sql).toContain("ts_ms >= 1700000000000");
        expect(sql).not.toContain("ts_ms <=");
    });

    /**
     * `instr`, not `LIKE`: the needle is arbitrary text a user typed, and under
     * `LIKE` a `%` or `_` in it would silently become a wildcard — so searching
     * for a literal `100%` would match lines that do not contain it.
     */
    it("searches by substring rather than a LIKE pattern", () => {
        expect.assertions(2);

        const sql = buildLocalLogQuery({ search: "100%" });

        expect(sql).toContain("instr(message, '100%') > 0");
        expect(sql).not.toContain("LIKE");
    });

    it("escapes quotes rather than letting a filter close the literal", () => {
        expect.assertions(1);

        expect(buildLocalLogQuery({ search: "it's" })).toContain("instr(message, 'it''s') > 0");
    });

    it("ignores a level the capture cannot represent", () => {
        expect.assertions(1);

        // The store records the console channel, so `fatal` would match nothing —
        // dropping it beats emitting `level = 'fatal'` and returning silence.
        expect(buildLocalLogQuery({ level: "fatal" })).not.toContain("level =");
    });

    it("clamps the limit at both ends", () => {
        expect.assertions(2);

        expect(buildLocalLogQuery({ limit: 0 })).toContain("LIMIT 1");
        expect(buildLocalLogQuery({ limit: MAX_LOCAL_LOG_LIMIT + 1000 })).toContain(`LIMIT ${String(MAX_LOCAL_LOG_LIMIT)}`);
    });
});

describe(unwrapConsoleMessage, () => {
    /**
     * The regression that matters. The capture stores `JSON.stringify` of the
     * console ARGUMENTS, and `ctx.log` emits its structured event as
     * `console.log(jsonString)` — so left wrapped, the envelope is double-encoded,
     * the shared formatter does not recognise it, and every `ctx.log` line prints
     * as escaped JSON. That is precisely the output this command replaces.
     */
    it("recovers a ctx.log envelope so the shared formatter can read it", () => {
        expect.assertions(2);

        const envelope = JSON.stringify({ function: "channels:create", level: "info", message: "channel created", source: "lunora", type: "log" });
        const stored = JSON.stringify(envelope);

        expect(formatLunoraEvent(stored)).toBeUndefined();
        expect(formatLunoraEvent(unwrapConsoleMessage(stored))).toMatchObject({ kind: "log" });
    });

    it("unwraps a single string argument", () => {
        expect.assertions(1);

        expect(unwrapConsoleMessage(JSON.stringify("jsrpc"))).toBe("jsrpc");
    });

    it("joins a multi-argument call the way console renders it", () => {
        expect.assertions(1);

        expect(unwrapConsoleMessage(JSON.stringify(["ready in", "12ms"]))).toBe("ready in 12ms");
    });

    it("returns a non-JSON line untouched rather than guessing", () => {
        expect.assertions(1);

        expect(unwrapConsoleMessage("plain output")).toBe("plain output");
    });

    it("unwraps exactly one level, so quoted content survives", () => {
        expect.assertions(1);

        expect(unwrapConsoleMessage(JSON.stringify('he said "hi"'))).toBe('he said "hi"');
    });
});

describe(mapLocalLogRows, () => {
    /**
     * Read by column NAME, not position: the response carries its own `columns`
     * array, so a runtime that adds or reorders a column would otherwise shift
     * every field silently.
     */
    it("maps by column name, tolerating a reordered response", () => {
        expect.assertions(1);

        const rows = mapLocalLogRows({
            columns: ["level", "ts_ms", "message", "span_id", "trace_id"],
            rows: [["warn", 1_700_000_000_000, JSON.stringify("careful"), "span1", "trace1"]],
        });

        expect(rows).toStrictEqual([{ level: "warn", message: "careful", spanId: "span1", traceId: "trace1", tsMs: 1_700_000_000_000 }]);
    });

    /** The query reads newest-first so `--limit` keeps the most recent lines; display is oldest-first. */
    it("reverses to oldest-first for display", () => {
        expect.assertions(1);

        const rows = mapLocalLogRows({
            columns: ["ts_ms", "message"],
            rows: [
                [3, JSON.stringify("third")],
                [2, JSON.stringify("second")],
                [1, JSON.stringify("first")],
            ],
        });

        expect(rows.map((row) => row.message)).toStrictEqual(["first", "second", "third"]);
    });

    it("answers an empty result without throwing", () => {
        expect.assertions(1);

        expect(mapLocalLogRows(undefined)).toStrictEqual([]);
    });
});

describe(parseTimeBound, () => {
    it("accepts epoch millis and ISO 8601", () => {
        expect.assertions(2);

        expect(parseTimeBound("1700000000000")).toBe(1_700_000_000_000);
        expect(parseTimeBound("2026-08-28T00:00:00.000Z")).toBe(Date.parse("2026-08-28T00:00:00.000Z"));
    });

    it("reports an unparseable bound rather than silently dropping it", () => {
        expect.assertions(2);

        expect(parseTimeBound("yesterday")).toBeUndefined();
        expect(parseTimeBound("")).toBeUndefined();
    });
});

describe(queryLocalObservability, () => {
    const ok = (result: unknown): Response => Response.json({ errors: [], result, success: true }, { status: 200 });

    it("posts the SQL to the dev server's endpoint", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(ok({ columns: [], rows: [] }));

        await queryLocalObservability("SELECT 1", { fetch: fetchMock, url: "http://localhost:5174/" });

        const [url, init] = fetchMock.mock.calls[0] ?? [];

        // The trailing slash on the base URL must not double up on the path.
        expect(url).toBe("http://localhost:5174/cdn-cgi/local/explorer/api/local/observability/query");
        expect((init as { method?: string }).method).toBe("POST");
        expect((init as { body?: string }).body).toBe(JSON.stringify({ sql: "SELECT 1" }));
    });

    /**
     * Every failure here is the same user mistake wearing a different hat — no dev
     * server, wrong port, or a plugin too old to expose the endpoint. A bare
     * `ECONNREFUSED` would send someone hunting through their own app, so each
     * message names the fix.
     */
    it("explains an unreachable dev server instead of surfacing a socket error", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("connect ECONNREFUSED"));

        await expect(queryLocalObservability("SELECT 1", { fetch: fetchMock })).rejects.toThrow(/lunora dev|--url/u);
    });

    it("explains a 404 as a missing endpoint rather than a failed query", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("nope", { status: 404 }));

        await expect(queryLocalObservability("SELECT 1", { fetch: fetchMock })).rejects.toThrow(/1\.54/u);
    });

    it("surfaces a rejected query with the endpoint's own error text", async () => {
        expect.assertions(1);

        const fetchMock = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValue(Response.json({ errors: [{ message: "no such column: nope" }], success: false }, { status: 200 }));

        await expect(queryLocalObservability("SELECT nope", { fetch: fetchMock })).rejects.toThrow(LocalObservabilityError);
    });
});

describe(readLocalLogs, () => {
    it("reads and maps in one call", async () => {
        expect.assertions(1);

        const fetchMock = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValue(Response.json({ result: { columns: ["ts_ms", "message"], rows: [[1, JSON.stringify("hi")]] }, success: true }, { status: 200 }));

        await expect(readLocalLogs({ limit: 5 }, { fetch: fetchMock })).resolves.toMatchObject([{ message: "hi" }]);
    });
});
