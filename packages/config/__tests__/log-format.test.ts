import { describe, expect, it } from "vitest";

import { formatLunoraEvent } from "../src/log-format";

/** Build a one-line JSON event string the runtime would emit to `console`. */
const event = (fields: Record<string, unknown>): string => JSON.stringify({ source: "lunora", ...fields });

describe("formatLunoraEvent", () => {
    describe("non-lunora input", () => {
        it.each([
            ["plain log text", "listening on http://localhost:8787"],
            ["empty string", ""],
            ["non-JSON braces", "{ not json"],
            ["JSON without source", JSON.stringify({ function: "x", type: "log" })],
            ["JSON with foreign source", JSON.stringify({ source: "wrangler", type: "log" })],
            ["JSON array", "[1,2,3]"],
        ])("returns undefined for %s", (_label, line) => {
            expect.assertions(1);

            expect(formatLunoraEvent(line)).toBeUndefined();
        });

        it("does not throw on malformed JSON that starts and ends with braces", () => {
            expect.assertions(1);

            expect(formatLunoraEvent('{"source":"lunora", oops}')).toBeUndefined();
        });
    });

    describe("log events", () => {
        it("formats a log line attributed to its function at info level", () => {
            expect.assertions(1);

            expect(formatLunoraEvent(event({ function: "messages:list", level: "info", message: "loaded 3 rows", type: "log" }))).toStrictEqual({
                kind: "log",
                level: "info",
                text: "messages:list  loaded 3 rows",
            });
        });

        it("renders structured fields as compact key=value pairs after the message", () => {
            expect.assertions(1);

            expect(
                formatLunoraEvent(
                    event({
                        fields: { attempt: 2, nested: { sku: "x" }, orderId: "o-1" },
                        function: "orders:place",
                        level: "info",
                        message: "placed",
                        type: "log",
                    }),
                )?.text,
            ).toBe('orders:place  placed  attempt=2 nested={"sku":"x"} orderId=o-1');
        });

        it("appends a short trace-id suffix when the line carries one", () => {
            expect.assertions(1);

            expect(
                formatLunoraEvent(event({ function: "a:b", level: "info", message: "hi", traceId: "4bf92f3577b34da6a3ce929d0e0e4736", type: "log" }))?.text,
            ).toBe("a:b  hi  trace=4bf92f35");
        });

        it("surfaces trace/debug at info and fatal at error", () => {
            expect.assertions(3);

            expect(formatLunoraEvent(event({ function: "a:b", level: "trace", message: "m", type: "log" }))?.level).toBe("info");
            expect(formatLunoraEvent(event({ function: "a:b", level: "debug", message: "m", type: "log" }))?.level).toBe("info");
            expect(formatLunoraEvent(event({ function: "a:b", level: "fatal", message: "down", type: "log" }))?.level).toBe("error");
        });

        it("maps the bare `log` level onto info", () => {
            expect.assertions(1);

            expect(formatLunoraEvent(event({ function: "a:b", level: "log", message: "hi", type: "log" }))?.level).toBe("info");
        });

        it("surfaces warn and error levels", () => {
            expect.assertions(2);

            expect(formatLunoraEvent(event({ function: "a:b", level: "warn", message: "careful", type: "log" }))?.level).toBe("warn");
            expect(formatLunoraEvent(event({ function: "a:b", level: "error", message: "boom", type: "log" }))?.level).toBe("error");
        });

        it("falls back to <unknown> when the function is missing", () => {
            expect.assertions(1);

            expect(formatLunoraEvent(event({ level: "info", message: "orphan", type: "log" }))?.text).toBe("<unknown>  orphan");
        });

        it("appends the shard as function@shard when present", () => {
            expect.assertions(1);

            expect(formatLunoraEvent(event({ function: "messages:list", level: "info", message: "hi", shard: "room-9", type: "log" }))?.text).toBe(
                "messages:list@room-9  hi",
            );
        });

        it("omits the default single-DO root sentinel from the label", () => {
            expect.assertions(1);

            expect(formatLunoraEvent(event({ function: "messages:list", level: "info", message: "hi", shard: "__root__", type: "log" }))?.text).toBe(
                "messages:list  hi",
            );
        });
    });

    describe("request events", () => {
        it("formats a successful dispatch with duration and tables", () => {
            expect.assertions(1);

            const formatted = formatLunoraEvent(
                event({ durationMs: 3.4, function: "messages:list", outcome: "ok", tablesRead: ["messages"], type: "request" }),
            );

            expect(formatted).toStrictEqual({ kind: "rpc", level: "info", text: "messages:list  ok  3ms  read[messages]" });
        });

        it("marks writes and cache hits", () => {
            expect.assertions(1);

            const formatted = formatLunoraEvent(
                event({ cacheHit: true, durationMs: 1, function: "m:send", outcome: "ok", tablesWritten: ["messages", "channels"], type: "request" }),
            );

            expect(formatted?.text).toBe("m:send  ok  1ms  write[messages,channels]  cached");
        });

        it("renders an error dispatch at error level with the message", () => {
            expect.assertions(1);

            const formatted = formatLunoraEvent(event({ durationMs: 9, error: "not authorized", function: "m:send", outcome: "error", type: "request" }));

            expect(formatted).toStrictEqual({ kind: "rpc", level: "error", text: "m:send  error  9ms  not authorized" });
        });

        it("renders ?ms when the duration is absent", () => {
            expect.assertions(1);

            expect(formatLunoraEvent(event({ function: "a:b", outcome: "ok", type: "request" }))?.text).toBe("a:b  ok  ?ms");
        });

        it("attributes the dispatch to function@shard when sharded", () => {
            expect.assertions(1);

            expect(formatLunoraEvent(event({ durationMs: 2, function: "m:send", outcome: "ok", shard: "tenant-7", type: "request" }))?.text).toBe(
                "m:send@tenant-7  ok  2ms",
            );
        });

        it("omits the default single-DO root sentinel from the dispatch label", () => {
            expect.assertions(1);

            expect(formatLunoraEvent(event({ durationMs: 2, function: "m:send", outcome: "ok", shard: "__root__", type: "request" }))?.text).toBe(
                "m:send  ok  2ms",
            );
        });
    });

    describe("container lifecycle events", () => {
        it("formats a start event with a truncated instance id", () => {
            expect.assertions(2);

            const line = formatLunoraEvent(event({ container: "transcoder", event: "start", instance: "do-instance-0001", type: "container" }));

            expect(line?.level).toBe("info");
            expect(line?.text).toBe("container:transcoder#do-insta  start");
        });

        it("surfaces an error event on the error channel with its message", () => {
            expect.assertions(2);

            const line = formatLunoraEvent(
                event({ container: "transcoder", event: "error", instance: "do-instance-0001", message: "boom", type: "container" }),
            );

            expect(line?.level).toBe("error");
            expect(line?.text).toBe("container:transcoder#do-insta  error  boom");
        });

        it("omits the instance suffix when the id is unknown", () => {
            expect.assertions(1);

            expect(formatLunoraEvent(event({ container: "transcoder", event: "stop", instance: "unknown", type: "container" }))?.text).toBe(
                "container:transcoder  stop",
            );
        });
    });

    it("returns undefined for a lunora event of an unknown type", () => {
        expect.assertions(1);

        expect(formatLunoraEvent(event({ type: "metric" }))).toBeUndefined();
    });
});
