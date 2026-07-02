import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogEvent, ObservabilityEvent } from "../src/observability";
import type { AnalyticsEngineDataPointLike } from "../src/observability-sinks";
import { analyticsEngineSink, combineSinks, consoleSink, sentrySink, webhookSink } from "../src/observability-sinks";

const okEvent: ObservabilityEvent = { durationMs: 5, functionPath: "messages:list", ok: true, shardKey: "channel-1" };
const errorEvent: ObservabilityEvent = {
    durationMs: 9,
    error: { code: "CONFLICT", message: "boom: user@example.com", status: 409 },
    functionPath: "messages:send",
    ok: false,
    shardKey: "channel-1",
};

describe("observability-sinks", () => {
    describe("consoleSink", () => {
        let log: ReturnType<typeof vi.spyOn>;
        let error: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            log = vi.spyOn(console, "log").mockImplementation(() => undefined);
            error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("logs ok events via console.log and error events via console.error", () => {
            expect.assertions(2);

            const sink = consoleSink();

            sink.onRpc!(okEvent);
            sink.onRpc!(errorEvent);

            expect(log).toHaveBeenCalledWith("[lunora:rpc]", okEvent);
            expect(error).toHaveBeenCalledWith("[lunora:rpc]", errorEvent);
        });

        it("filters out ok events when onlyErrors is set", () => {
            expect.assertions(2);

            const sink = consoleSink({ onlyErrors: true });

            sink.onRpc!(okEvent);
            sink.onRpc!(errorEvent);

            expect(log).not.toHaveBeenCalled();
            expect(error).toHaveBeenCalledTimes(1);
        });

        it("logs ctx.log events, routing error level to console.error and others to console.log", () => {
            expect.assertions(2);

            const sink = consoleSink();

            sink.onLog!({ args: ["hi"], functionPath: "messages:list", level: "info", message: "hi", ts: 1 });
            sink.onLog!({ args: ["boom"], functionPath: "messages:send", level: "error", message: "boom", ts: 2 });

            expect(log).toHaveBeenCalledWith("[lunora:log]", "messages:list", "hi");
            expect(error).toHaveBeenCalledWith("[lunora:log]", "messages:send", "boom");
        });

        it("emits log events even when onlyErrors filters the rpc stream", () => {
            expect.assertions(1);

            const sink = consoleSink({ onlyErrors: true });

            sink.onLog!({ args: [], functionPath: "a:b", level: "info", message: "still shown", ts: 1 });

            expect(log).toHaveBeenCalledWith("[lunora:log]", "a:b", "still shown");
        });
    });

    describe("webhookSink", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("pOSTs the serialized event with merged headers", () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({ headers: { authorization: "Bearer secret" }, url: "https://ingest.example/events" });

            sink.onRpc!(okEvent);

            expect(fetchMock).toHaveBeenCalledTimes(1);

            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(url).toBe("https://ingest.example/events");
            expect(init).toMatchObject({
                headers: { authorization: "Bearer secret", "content-type": "application/json" },
                method: "POST",
            });
            expect(init.body).toBe(JSON.stringify(okEvent));

            vi.unstubAllGlobals();
        });

        it("swallows a rejected fetch", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => {
                throw new Error("network down");
            });
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({ url: "https://ingest.example/events" });

            expect(() => {
                sink.onRpc!(okEvent);
            }).not.toThrow();

            // Let the rejected promise settle without an unhandled rejection.
            await Promise.resolve();

            vi.unstubAllGlobals();
        });

        it("swallows a synchronous fetch throw", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(() => {
                throw new Error("invalid url");
            });
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({ url: "not-a-url" });

            expect(() => {
                sink.onRpc!(okEvent);
            }).not.toThrow();

            vi.unstubAllGlobals();
        });

        it("skips ok events when onlyErrors is set", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({ onlyErrors: true, url: "https://ingest.example/events" });

            sink.onRpc!(okEvent);

            expect(fetchMock).not.toHaveBeenCalled();

            sink.onRpc!(errorEvent);

            expect(fetchMock).toHaveBeenCalledTimes(1);

            vi.unstubAllGlobals();
        });

        it("lets a differently-cased Content-Type header override the default without duplicating it", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({
                headers: { "Content-Type": "application/x-ndjson" },
                url: "https://ingest.example/events",
            });

            sink.onRpc!(okEvent);

            const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            const sentHeaders = init.headers as Record<string, string>;

            // The override wins and there is exactly one content-type key — no
            // combined "application/json, application/x-ndjson".
            expect(sentHeaders["content-type"]).toBe("application/x-ndjson");
            expect(Object.keys(sentHeaders).filter((key) => key.toLowerCase() === "content-type")).toHaveLength(1);

            vi.unstubAllGlobals();
        });

        it("applies a transform to scrub the event before sending", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({
                transform: (event) => {
                    return { ...event, error: event.error ? { ...event.error, message: "[redacted]" } : undefined };
                },
                url: "https://ingest.example/events",
            });

            sink.onRpc!(errorEvent);

            const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(init.body).toContain("[redacted]");
            expect(init.body).not.toContain("user@example.com");

            vi.unstubAllGlobals();
        });

        it("drops the event when transform returns null", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({ transform: () => null, url: "https://ingest.example/events" });

            sink.onRpc!(errorEvent);

            expect(fetchMock).not.toHaveBeenCalled();

            vi.unstubAllGlobals();
        });

        it("fails closed by dropping the event when transform throws", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({
                transform: () => {
                    throw new Error("scrub failed");
                },
                url: "https://ingest.example/events",
            });

            expect(() => {
                sink.onRpc!(errorEvent);
            }).not.toThrow();
            expect(fetchMock).not.toHaveBeenCalled();

            vi.unstubAllGlobals();
        });
    });

    describe("sentrySink", () => {
        it("captures only error events by default", () => {
            expect.assertions(2);

            const capture = vi.fn<(event: ObservabilityEvent) => void>();
            const sink = sentrySink({ capture });

            sink.onRpc!(okEvent);

            expect(capture).not.toHaveBeenCalled();

            sink.onRpc!(errorEvent);

            expect(capture).toHaveBeenCalledWith(errorEvent);
        });

        it("captures all events when onlyErrors is false", () => {
            expect.assertions(1);

            const capture = vi.fn<(event: ObservabilityEvent) => void>();
            const sink = sentrySink({ capture, onlyErrors: false });

            sink.onRpc!(okEvent);
            sink.onRpc!(errorEvent);

            expect(capture).toHaveBeenCalledTimes(2);
        });

        it("swallows a throwing capture callback", () => {
            expect.assertions(1);

            const sink = sentrySink({
                capture: () => {
                    throw new Error("sentry down");
                },
            });

            expect(() => {
                sink.onRpc!(errorEvent);
            }).not.toThrow();
        });
    });

    describe("combineSinks", () => {
        it("fans out to every child sink", () => {
            expect.assertions(2);

            const a = vi.fn<(event: ObservabilityEvent) => void>();
            const b = vi.fn<(event: ObservabilityEvent) => void>();
            const sink = combineSinks({ onRpc: a }, { onRpc: b });

            sink.onRpc!(okEvent);

            expect(a).toHaveBeenCalledWith(okEvent, undefined);
            expect(b).toHaveBeenCalledWith(okEvent, undefined);
        });

        it("forwards the per-event context (ctx.waitUntil) to every child sink", () => {
            expect.assertions(2);

            const a = vi.fn<(event: ObservabilityEvent, context?: { waitUntil?: (promise: Promise<unknown>) => void }) => void>();
            const b = vi.fn<(event: ObservabilityEvent, context?: { waitUntil?: (promise: Promise<unknown>) => void }) => void>();
            const sink = combineSinks({ onRpc: a }, { onRpc: b });
            const context = { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() };

            sink.onRpc!(okEvent, context);

            // Dropping the context here would silently degrade a wrapped network
            // sink (e.g. webhookSink) to fire-and-forget — assert it is threaded.
            expect(a).toHaveBeenCalledWith(okEvent, context);
            expect(b).toHaveBeenCalledWith(okEvent, context);
        });

        it("isolates a throwing child so the rest still run", () => {
            expect.assertions(1);

            const b = vi.fn<(event: ObservabilityEvent) => void>();
            const sink = combineSinks(
                {
                    onRpc: () => {
                        throw new Error("bad sink");
                    },
                },
                { onRpc: b },
            );

            sink.onRpc!(okEvent);

            expect(b).toHaveBeenCalledWith(okEvent, undefined);
        });

        it("fans out log events to every child, isolating a thrower", () => {
            expect.assertions(2);

            const good = vi.fn<(event: LogEvent) => void>();
            const sink = combineSinks(
                {
                    onLog: () => {
                        throw new Error("bad log sink");
                    },
                },
                { onLog: good },
            );

            const logEvent: LogEvent = { args: [], functionPath: "a:b", level: "info", message: "m", ts: 1 };

            expect(() => {
                sink.onLog!(logEvent);
            }).not.toThrow();
            expect(good).toHaveBeenCalledWith(logEvent, undefined);
        });
    });

    describe("analyticsEngineSink", () => {
        it("writes a data point with index, blob dimensions, and numeric metrics", () => {
            expect.assertions(3);

            const points: AnalyticsEngineDataPointLike[] = [];
            const sink = analyticsEngineSink({
                dataset: {
                    writeDataPoint: (point) => {
                        points.push(point);
                    },
                },
            });

            sink.onRpc!(okEvent);

            expect(points).toHaveLength(1);
            expect(points[0]).toStrictEqual({
                blobs: ["messages:list", "ok", "channel-1", "", ""],
                doubles: [5, 0, 0, 0],
                indexes: ["messages:list"],
            });
            // The error counter (double[1]) is 0 for a successful event.
            expect(points[0]?.doubles?.[1]).toBe(0);
        });

        it("records error code and a 1 error-count for failed events", () => {
            expect.assertions(2);

            const points: AnalyticsEngineDataPointLike[] = [];
            const sink = analyticsEngineSink({
                dataset: {
                    writeDataPoint: (point) => {
                        points.push(point);
                    },
                },
            });

            sink.onRpc!(errorEvent);

            expect(points[0]?.blobs).toStrictEqual(["messages:send", "error", "channel-1", "CONFLICT", ""]);
            expect(points[0]?.doubles).toStrictEqual([9, 1, 0, 0]);
        });

        it("captures fan-out cardinality and the aggregated table", () => {
            expect.assertions(2);

            const fanOutEvent: ObservabilityEvent = {
                durationMs: 12,
                fanOut: { failed: 1, shards: 4, table: "messages" },
                functionPath: "messages:countAll",
                ok: true,
            };
            const points: AnalyticsEngineDataPointLike[] = [];
            const sink = analyticsEngineSink({
                dataset: {
                    writeDataPoint: (point) => {
                        points.push(point);
                    },
                },
            });

            sink.onRpc!(fanOutEvent);

            expect(points[0]?.blobs).toStrictEqual(["messages:countAll", "ok", "", "", "messages"]);
            expect(points[0]?.doubles).toStrictEqual([12, 0, 4, 1]);
        });

        it("skips ok events when onlyErrors is set", () => {
            expect.assertions(1);

            const points: AnalyticsEngineDataPointLike[] = [];
            const sink = analyticsEngineSink({
                dataset: {
                    writeDataPoint: (point) => {
                        points.push(point);
                    },
                },
                onlyErrors: true,
            });

            sink.onRpc!(okEvent);
            sink.onRpc!(errorEvent);

            expect(points).toHaveLength(1);
        });

        it("swallows a throwing writeDataPoint so dispatch is never broken", () => {
            expect.assertions(1);

            const sink = analyticsEngineSink({
                dataset: {
                    writeDataPoint: () => {
                        throw new Error("AE unavailable");
                    },
                },
            });

            expect(() => {
                sink.onRpc!(okEvent);
            }).not.toThrow();
        });
    });
});
