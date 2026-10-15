import { describe, expect, it, vi } from "vitest";

import { WORKER_RUNTIME_TAG } from "../src/project-runtime";
import { groupTailEvents, parseLogMessage, parsePlainLog, parseTraceItem } from "../src/tail/parse";

/** Serialize a framework `type:"log"` console event the way `emitLogEvent` does. */
const logEvent = (fields: Record<string, unknown>): string => JSON.stringify({ source: "lunora", type: "log", ...fields });

describe(parseLogMessage, () => {
    it("decodes a full lunora log event from the console args array", () => {
        expect.assertions(1);

        const message = [
            logEvent({
                fields: { orderId: "o-1" },
                function: "orders:place",
                level: "info",
                message: "order placed",
                shard: "tenant-1",
                spanId: "00f067aa0ba902b7",
                traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                ts: 1700,
                userId: "user-1",
            }),
        ];

        expect(parseLogMessage(message)).toStrictEqual({
            createdAt: 1700,
            fields: { orderId: "o-1" },
            functionPath: "orders:place",
            level: "info",
            message: "order placed",
            shardKey: "tenant-1",
            spanId: "00f067aa0ba902b7",
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            userId: "user-1",
        });
    });

    it("accepts the JSON string directly (not only the args array)", () => {
        expect.assertions(1);

        expect(parseLogMessage(logEvent({ function: "a:b", level: "warn", message: "hi", ts: 1 }))?.message).toBe("hi");
    });

    it("folds an unknown or absent level to `log` and drops non-object fields", () => {
        expect.assertions(3);

        expect(parseLogMessage(logEvent({ level: "verbose", message: "m", ts: 1 }))?.level).toBe("log");
        expect(parseLogMessage(logEvent({ message: "m", ts: 1 }))?.level).toBe("log");
        expect(parseLogMessage(logEvent({ fields: [1, 2, 3], level: "info", message: "m", ts: 1 }))?.fields).toBeUndefined();
    });

    it.each([
        ["a plain console.log line", ["listening on http://localhost:8787"]],
        ["a non-lunora JSON object", [JSON.stringify({ source: "wrangler", type: "log" })]],
        ["a lunora request event (not a log)", [logEvent({ type: "request" })]],
        ["malformed JSON with the marker", ['{"source":"lunora", oops}']],
        ["a multi-arg console call", ["prefix", logEvent({ level: "info", message: "m" })]],
        ["a non-string message", [{ not: "a string" }]],
    ])("returns null for %s", (_label, message) => {
        expect.assertions(1);

        expect(parseLogMessage(message)).toBeNull();
    });
});

describe(parseTraceItem, () => {
    it("decodes every lunora log line and skips the rest of a trace item's console output", () => {
        expect.assertions(1);

        const item = {
            logs: [
                { message: ["plain wrangler line"] },
                { message: [logEvent({ function: "a:b", level: "error", message: "boom", ts: 2 })] },
                { message: [logEvent({ function: "a:b", level: "info", message: "ok", ts: 1 })] },
            ],
            scriptName: "blog-worker-v3",
        };

        expect(parseTraceItem(item).map((line) => line.message)).toStrictEqual(["boom", "ok"]);
    });
});

describe(groupTailEvents, () => {
    it("groups decoded lines per script, merging repeated items and dropping empties", () => {
        expect.assertions(2);

        const batches = groupTailEvents([
            { logs: [{ message: [logEvent({ level: "info", message: "one", ts: 1 })] }], scriptName: "app-v1" },
            { logs: [{ message: ["not a lunora line"] }], scriptName: "app-v1" },
            { logs: [{ message: [logEvent({ level: "warn", message: "two", ts: 2 })] }], scriptName: "app-v1" },
            { logs: [{ message: [logEvent({ level: "info", message: "solo", ts: 3 })] }], scriptName: "other-v1" },
            { logs: [{ message: ["only noise"] }], scriptName: "quiet-v1" },
            { logs: [{ message: [logEvent({ level: "info", message: "orphan", ts: 4 })] }], scriptName: null },
        ]);

        // `app-v1` merges both lines; `quiet-v1` (no lunora lines) and the
        // script-less item are dropped.
        expect(batches).toHaveLength(2);
        expect(batches.find((batch) => batch.scriptName === "app-v1")?.lines.map((line) => line.message)).toStrictEqual(["one", "two"]);
    });

    it("returns an empty array when nothing decodes", () => {
        expect.assertions(1);

        expect(groupTailEvents([{ logs: [{ message: ["noise"] }], scriptName: "app-v1" }])).toStrictEqual([]);
    });
});

describe("plain Cloudflare Worker console lines", () => {
    const item = (tags: null | string[] | undefined, logs: { level?: unknown; message?: unknown; timestamp?: unknown }[]) => {
        return { logs, scriptName: "acme", scriptTags: tags };
    };

    it("keeps every console line of a script tagged as a plain Worker, shaped like a ctx.log line", () => {
        expect.assertions(1);

        const lines = parseTraceItem(
            item(
                ["org:o", WORKER_RUNTIME_TAG],
                [
                    { level: "log", message: ["user", 42, { ok: true }], timestamp: 1700 },
                    { level: "warn", message: ["slow upstream"], timestamp: 1701 },
                    { level: "error", message: ["boom"], timestamp: 1702 },
                ],
            ),
        );

        expect(lines).toStrictEqual([
            { createdAt: 1700, level: "log", message: 'user 42 {"ok":true}' },
            { createdAt: 1701, level: "warn", message: "slow upstream" },
            { createdAt: 1702, level: "error", message: "boom" },
        ]);
    });

    it("drops ordinary console lines of a Lunora app, as before", () => {
        expect.assertions(2);

        const logs = [{ level: "log", message: ["plain"], timestamp: 1 }, { message: [logEvent({ level: "info", message: "structured" })] }];

        expect(parseTraceItem(item(["org:o"], logs)).map((line) => line.message)).toStrictEqual(["structured"]);
        expect(parseTraceItem(item(undefined, logs)).map((line) => line.message)).toStrictEqual(["structured"]);
    });

    it("reads a lunora-shaped line from a plain Worker as plain text, with no structured fields", () => {
        expect.assertions(2);

        const event = logEvent({ function: "f", level: "warn", message: "m" });
        const [line] = parseTraceItem(item([WORKER_RUNTIME_TAG], [{ level: "log", message: [event] }]));

        expect(line).toStrictEqual({ level: "log", message: event });
        expect(line).not.toHaveProperty("functionPath");
    });

    it("counts a plain Worker's lunora-shaped lines against its plain-line allowance", () => {
        expect.assertions(1);

        const logs = Array.from({ length: 450 }, () => {
            return { level: "log", message: [logEvent({ level: "info", message: "spoof" })] };
        });
        const lines = groupTailEvents([item([WORKER_RUNTIME_TAG], logs)]).flatMap((batch) => batch.lines);

        expect(lines).toHaveLength(401);
    });

    it("bounds each argument while formatting it, so a huge logged value is never serialised whole", () => {
        expect.assertions(4);

        const huge = {
            rows: Array.from({ length: 50_000 }, (_, index) => {
                return { index, text: "x".repeat(20) };
            }),
        };
        const stringify = vi.spyOn(JSON, "stringify");
        const line = parsePlainLog({ level: "log", message: ["dump", huge] });
        const produced = stringify.mock.results.map((result) => (typeof result.value === "string" ? result.value.length : 0));

        stringify.mockRestore();

        expect(line?.message).toBe("dump [object over 4091 characters]");
        expect(produced.every((length) => length <= 4096)).toBe(true);
        expect(parsePlainLog({ level: "log", message: ["a".repeat(3000), "b".repeat(3000)] })?.message).toHaveLength(4096);
        expect(parsePlainLog({ level: "log", message: [{ ok: true }] })?.message).toBe('{"ok":true}');
    });

    it("folds an unknown level to log, skips an empty line and caps a long one", () => {
        expect.assertions(3);

        expect(parsePlainLog({ level: "verbose", message: ["x"] })).toStrictEqual({ level: "log", message: "x" });
        expect(parsePlainLog({ level: "log", message: [""] })).toBeNull();
        expect(parsePlainLog({ level: "log", message: ["y".repeat(10_000)] })?.message).toHaveLength(4096);
    });

    it("bounds a script's plain lines per flush, counts the rest in one line, and splits what it keeps into ingestible batches", () => {
        expect.assertions(4);

        // Three requests of 250 console lines each, from one plain Worker: 750 in one flush.
        const logs = Array.from({ length: 250 }, (_, index) => {
            return { level: "log", message: [`line ${String(index)}`] };
        });
        const batches = groupTailEvents([item([WORKER_RUNTIME_TAG], logs), item([WORKER_RUNTIME_TAG], logs), item([WORKER_RUNTIME_TAG], logs)]);
        const lines = batches.flatMap((batch) => batch.lines);

        expect(batches.map((batch) => [batch.scriptName, batch.lines.length])).toStrictEqual([["acme", 401]]);
        expect(lines.at(-1)).toStrictEqual({
            level: "warn",
            message: "350 console line(s) dropped from one log flush: Lunora Cloud keeps at most 400 plain console lines per Worker per flush",
        });

        // ctx.log lines are not plain lines: they never spend the budget, and a script with many still splits at the ingest's cap.
        const structured = Array.from({ length: 600 }, () => {
            return { message: [logEvent({ level: "info", message: "s" })] };
        });
        const split = groupTailEvents([item(["org:o"], structured)]);

        expect(split.map((batch) => batch.lines.length)).toStrictEqual([500, 100]);
        expect(split.every((batch) => batch.scriptName === "acme")).toBe(true);
    });

    it("groups a plain Worker's lines under its script for the ingest", () => {
        expect.assertions(1);

        expect(groupTailEvents([item([WORKER_RUNTIME_TAG], [{ level: "info", message: ["hi"], timestamp: 5 }])])).toStrictEqual([
            { lines: [{ createdAt: 5, level: "info", message: "hi" }], scriptName: "acme" },
        ]);
    });
});
