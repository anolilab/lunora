import { describe, expect, it } from "vitest";

import { formatCirrusEvent } from "../src/log-format";

/** Build a one-line JSON event string the runtime would emit to `console`. */
const event = (fields: Record<string, unknown>): string => JSON.stringify({ source: "cirrus", ...fields });

describe("formatCirrusEvent", () => {
    describe("non-cirrus input", () => {
        it.each([
            ["plain log text", "listening on http://localhost:8787"],
            ["empty string", ""],
            ["non-JSON braces", "{ not json"],
            ["JSON without source", JSON.stringify({ function: "x", type: "log" })],
            ["JSON with foreign source", JSON.stringify({ source: "wrangler", type: "log" })],
            ["JSON array", "[1,2,3]"],
        ])("returns undefined for %s", (_label, line) => {
            expect.assertions(1);

            expect(formatCirrusEvent(line)).toBeUndefined();
        });

        it("does not throw on malformed JSON that starts and ends with braces", () => {
            expect.assertions(1);

            expect(formatCirrusEvent('{"source":"cirrus", oops}')).toBeUndefined();
        });
    });

    describe("log events", () => {
        it("formats a log line attributed to its function at info level", () => {
            expect.assertions(1);

            expect(formatCirrusEvent(event({ function: "messages:list", level: "info", message: "loaded 3 rows", type: "log" }))).toStrictEqual({
                kind: "log",
                level: "info",
                text: "messages:list  loaded 3 rows",
            });
        });

        it("maps the bare `log` level onto info", () => {
            expect.assertions(1);

            expect(formatCirrusEvent(event({ function: "a:b", level: "log", message: "hi", type: "log" }))?.level).toBe("info");
        });

        it("surfaces warn and error levels", () => {
            expect.assertions(2);

            expect(formatCirrusEvent(event({ function: "a:b", level: "warn", message: "careful", type: "log" }))?.level).toBe("warn");
            expect(formatCirrusEvent(event({ function: "a:b", level: "error", message: "boom", type: "log" }))?.level).toBe("error");
        });

        it("falls back to <unknown> when the function is missing", () => {
            expect.assertions(1);

            expect(formatCirrusEvent(event({ level: "info", message: "orphan", type: "log" }))?.text).toBe("<unknown>  orphan");
        });

        it("appends the shard as function@shard when present", () => {
            expect.assertions(1);

            expect(formatCirrusEvent(event({ function: "messages:list", level: "info", message: "hi", shard: "room-9", type: "log" }))?.text).toBe(
                "messages:list@room-9  hi",
            );
        });
    });

    describe("request events", () => {
        it("formats a successful dispatch with duration and tables", () => {
            expect.assertions(1);

            const formatted = formatCirrusEvent(
                event({ durationMs: 3.4, function: "messages:list", outcome: "ok", tablesRead: ["messages"], type: "request" }),
            );

            expect(formatted).toStrictEqual({ kind: "rpc", level: "info", text: "messages:list  ok  3ms  read[messages]" });
        });

        it("marks writes and cache hits", () => {
            expect.assertions(1);

            const formatted = formatCirrusEvent(
                event({ cacheHit: true, durationMs: 1, function: "m:send", outcome: "ok", tablesWritten: ["messages", "channels"], type: "request" }),
            );

            expect(formatted?.text).toBe("m:send  ok  1ms  write[messages,channels]  cached");
        });

        it("renders an error dispatch at error level with the message", () => {
            expect.assertions(1);

            const formatted = formatCirrusEvent(event({ durationMs: 9, error: "not authorized", function: "m:send", outcome: "error", type: "request" }));

            expect(formatted).toStrictEqual({ kind: "rpc", level: "error", text: "m:send  error  9ms  not authorized" });
        });

        it("renders ?ms when the duration is absent", () => {
            expect.assertions(1);

            expect(formatCirrusEvent(event({ function: "a:b", outcome: "ok", type: "request" }))?.text).toBe("a:b  ok  ?ms");
        });

        it("attributes the dispatch to function@shard when sharded", () => {
            expect.assertions(1);

            expect(formatCirrusEvent(event({ durationMs: 2, function: "m:send", outcome: "ok", shard: "tenant-7", type: "request" }))?.text).toBe(
                "m:send@tenant-7  ok  2ms",
            );
        });
    });

    it("returns undefined for a cirrus event of an unknown type", () => {
        expect.assertions(1);

        expect(formatCirrusEvent(event({ type: "metric" }))).toBeUndefined();
    });
});
