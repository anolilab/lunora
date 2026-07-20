import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogEvent, LogLevel, ObservabilityEvent, SpanEvent } from "../src/observability";
import type { AnalyticsEngineDataPointLike } from "../src/observability-sinks";
import { analyticsEngineSink, combineSinks, consoleSink, otlpSink, pipelineLogSink, sentrySink, webhookSink } from "../src/observability-sinks";

const okEvent: ObservabilityEvent = { durationMs: 5, functionPath: "messages:list", ok: true, shardKey: "channel-1" };

/** One `ctx.trace` span nested under a dispatch's RPC span. */
const spanEvent: SpanEvent = {
    durationMs: 25,
    functionPath: "orders:checkout",
    name: "stripe.charge",
    ok: true,
    parentSpanId: "b7ad6b7169203331",
    shardKey: "tenant-1",
    spanId: "00f067aa0ba902b7",
    startTs: 1_700_000_000_000,
    traceId: "0af7651916cd43dd8448eb211c80319c",
};
const errorEvent: ObservabilityEvent = {
    durationMs: 9,
    error: { code: "CONFLICT", message: "boom: user@example.com", status: 409 },
    functionPath: "messages:send",
    ok: false,
    shardKey: "channel-1",
};

/** A 16-byte trace id, hex-encoded per the OTLP/JSON `trace_id` exception. */
const TRACE_ID_HEX = /^[0-9a-f]{32}$/;
/** An 8-byte span id, hex-encoded per the OTLP/JSON `span_id` exception. */
const SPAN_ID_HEX = /^[0-9a-f]{16}$/;
/** A `*UnixNano` value derived from whole milliseconds — the six trailing zeros are exact. */
const UNIX_NANO = /^\d+000000$/;

/** One OTLP `AnyValue`, as it appears in the JSON wire form. */
interface OtlpValue {
    boolValue?: boolean;
    doubleValue?: number;
    intValue?: string;
    stringValue?: string;
}

/** One OTLP `KeyValue` attribute. */
interface OtlpKeyValue {
    key: string;
    value: OtlpValue;
}

/** The subset of an OTLP span the tests assert on. */
interface ParsedSpan {
    attributes: OtlpKeyValue[];
    endTimeUnixNano: string;
    kind: number;
    name: string;
    /** Absent on the RPC dispatch span; set on a `ctx.trace` span. */
    parentSpanId?: string;
    spanId: string;
    startTimeUnixNano: string;
    status: { code: number; message?: string };
    traceId: string;
}

/** The subset of an OTLP log record the tests assert on. */
interface ParsedLogRecord {
    attributes: OtlpKeyValue[];
    body: OtlpValue;
    severityNumber: number;
    severityText: string;
    spanId?: string;
    timeUnixNano: string;
    traceId?: string;
}

/** Look up an attribute's value by key. */
const attrValue = (attributes: OtlpKeyValue[], key: string): OtlpValue | undefined => attributes.find((entry) => entry.key === key)?.value;

/** Decode a POSTed OTLP trace-export body down to its single span + resource attributes. */
const spanFrom = (init: RequestInit): { resourceAttributes: OtlpKeyValue[]; scopeName: string; span: ParsedSpan } => {
    const parsed = JSON.parse(init.body as string) as {
        resourceSpans: { resource: { attributes: OtlpKeyValue[] }; scopeSpans: { scope: { name: string }; spans: ParsedSpan[] }[] }[];
    };
    const resourceSpan = parsed.resourceSpans[0]!;
    const scopeSpan = resourceSpan.scopeSpans[0]!;

    return { resourceAttributes: resourceSpan.resource.attributes, scopeName: scopeSpan.scope.name, span: scopeSpan.spans[0]! };
};

/** Decode a POSTed OTLP log-export body down to its single log record + resource attributes. */
const logFrom = (init: RequestInit): { record: ParsedLogRecord; resourceAttributes: OtlpKeyValue[] } => {
    const parsed = JSON.parse(init.body as string) as {
        resourceLogs: { resource: { attributes: OtlpKeyValue[] }; scopeLogs: { logRecords: ParsedLogRecord[]; scope: { name: string } }[] }[];
    };
    const resourceLog = parsed.resourceLogs[0]!;

    return { record: resourceLog.scopeLogs[0]!.logRecords[0]!, resourceAttributes: resourceLog.resource.attributes };
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

        it("ships ctx.log lines too, applying transformLog fail-closed", () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const logEvent: LogEvent = { args: [], fields: { orderId: "o-1" }, functionPath: "orders:place", level: "info", message: "placed", ts: 1 };
            const sink = webhookSink({
                transformLog: (event) => {
                    return { ...event, fields: undefined };
                },
                url: "https://ingest.example/events",
            });

            sink.onLog!(logEvent);

            expect(fetchMock).toHaveBeenCalledTimes(1);
            // The redactor stripped `fields` before the line left the worker.
            expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe(JSON.stringify({ ...logEvent, fields: undefined }));

            // A throwing transformLog drops the line rather than shipping it raw.
            fetchMock.mockClear();
            const throwing = webhookSink({
                transformLog: () => {
                    throw new Error("scrub failed");
                },
                url: "https://ingest.example/events",
            });

            throwing.onLog!(logEvent);

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

        it("forwards ctx.log lines to captureLog when wired, and swallows its throws", () => {
            expect.assertions(3);

            const captureLog = vi.fn<(event: LogEvent) => void>();
            const sink = sentrySink({ capture: vi.fn(), captureLog });
            const logEvent: LogEvent = { args: [], fields: { orderId: "o-1" }, functionPath: "orders:place", level: "error", message: "boom", ts: 1 };

            sink.onLog!(logEvent);

            expect(captureLog).toHaveBeenCalledWith(logEvent);

            const throwing = sentrySink({
                capture: vi.fn(),
                captureLog: () => {
                    throw new Error("sentry down");
                },
            });

            expect(throwing.onLog).toBeDefined();
            expect(() => {
                throwing.onLog!(logEvent);
            }).not.toThrow();
        });

        it("omits onLog entirely when captureLog is not provided (logs stay out of Sentry)", () => {
            expect.assertions(1);

            const sink = sentrySink({ capture: vi.fn() });

            expect(sink.onLog).toBeUndefined();
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

        it("fans spans out to every child and isolates a throwing one", () => {
            expect.assertions(2);

            const b = vi.fn<(event: SpanEvent) => void>();
            const sink = combineSinks(
                {
                    onSpan: () => {
                        throw new Error("bad sink");
                    },
                },
                { onSpan: b },
            );

            expect(() => {
                sink.onSpan!(spanEvent);
            }).not.toThrow();
            expect(b).toHaveBeenCalledWith(spanEvent, undefined);
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

    describe("otlpSink", () => {
        afterEach(() => {
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        });

        it("posts a well-formed OTLP span to the traces endpoint for an ok rpc event", () => {
            expect.assertions(9);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onRpc!(okEvent);

            expect(fetchMock).toHaveBeenCalledTimes(1);

            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(url).toBe("https://collector.example/v1/traces");
            expect(init.method).toBe("POST");

            const { resourceAttributes, span } = spanFrom(init);

            expect(attrValue(resourceAttributes, "service.name")).toStrictEqual({ stringValue: "lunora" });
            expect(span.name).toBe("messages:list");
            // SPAN_KIND_SERVER — a dispatched RPC is server-side handling.
            expect(span.kind).toBe(2);
            // STATUS_CODE_OK, with no status message.
            expect(span.status).toStrictEqual({ code: 1 });
            expect(span.traceId).toMatch(TRACE_ID_HEX);
            expect(span.spanId).toMatch(SPAN_ID_HEX);
        });

        it("reuses the dispatch's trace/span ids when the event carries them", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onRpc!({ ...okEvent, spanId: "b7ad6b7169203331", traceId: "0af7651916cd43dd8448eb211c80319c" });

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            // The span rides the ids the runtime propagated as `traceparent`, not fresh ones.
            expect(span.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
            expect(span.spanId).toBe("b7ad6b7169203331");
        });

        it("encodes error status, error.type, and the status message for a failed event", () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onRpc!(errorEvent);

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            // STATUS_CODE_ERROR carries the human-readable message.
            expect(span.status).toStrictEqual({ code: 2, message: "boom: user@example.com" });
            expect(attrValue(span.attributes, "error.type")).toStrictEqual({ stringValue: "CONFLICT" });
            expect(attrValue(span.attributes, "lunora.error_status")).toStrictEqual({ intValue: "409" });
            expect(attrValue(span.attributes, "lunora.ok")).toStrictEqual({ boolValue: false });
        });

        it("derives span start and end from durationMs at nanosecond precision", () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onRpc!(okEvent);

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(span.startTimeUnixNano).toMatch(UNIX_NANO);
            expect(span.endTimeUnixNano).toMatch(UNIX_NANO);
            // end - start must equal durationMs (5ms) in nanos, exactly — BigInt
            // avoids the double-rounding a ~1.7e18 nanosecond value would suffer.
            expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBe(BigInt(5 * 1_000_000));
        });

        it("records fan-out cardinality and the aggregated table as attributes", () => {
            expect.assertions(4);

            const fanOutEvent: ObservabilityEvent = {
                durationMs: 12,
                fanOut: { failed: 1, shards: 4, table: "messages" },
                functionPath: "messages:countAll",
                ok: true,
            };
            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onRpc!(fanOutEvent);

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(attrValue(span.attributes, "lunora.fanout.table")).toStrictEqual({ stringValue: "messages" });
            expect(attrValue(span.attributes, "lunora.fanout.shards")).toStrictEqual({ intValue: "4" });
            expect(attrValue(span.attributes, "lunora.fanout.failed")).toStrictEqual({ intValue: "1" });
            // A fan-out has no single shard key.
            expect(attrValue(span.attributes, "lunora.shard_key")).toBeUndefined();
        });

        it("posts a well-formed OTLP log record to the logs endpoint", () => {
            expect.assertions(6);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onLog!({ args: ["hi"], functionPath: "messages:list", level: "info", message: "hello", shardKey: "channel-1", ts: 1700, userId: "user-1" });

            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(url).toBe("https://collector.example/v1/logs");

            const { record } = logFrom(init);

            expect(record.body).toStrictEqual({ stringValue: "hello" });
            expect(record.severityNumber).toBe(9);
            expect(record.severityText).toBe("INFO");
            // ts (1700ms) → nanos with six trailing zeros.
            expect(record.timeUnixNano).toBe("1700000000");
            expect(attrValue(record.attributes, "lunora.user_id")).toStrictEqual({ stringValue: "user-1" });
        });

        it("maps each log level to its OTLP severity number", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });
            const levels: LogLevel[] = ["trace", "debug", "info", "log", "warn", "error", "fatal"];

            for (const level of levels) {
                sink.onLog!({ args: [], functionPath: "a:b", level, message: "m", ts: 1 });
            }

            const numbers = fetchMock.mock.calls.map((call) => logFrom(call[1] as RequestInit).record.severityNumber);

            // trace=TRACE(1), debug=DEBUG(5), info=INFO(9), log→INFO(9), warn=WARN(13), error=ERROR(17), fatal=FATAL(21).
            expect(numbers).toStrictEqual([1, 5, 9, 9, 13, 17, 21]);
        });

        it("maps structured fields onto log-record attributes and correlates the record to its trace", () => {
            expect.assertions(6);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onLog!({
                args: ["order placed"],
                fields: { attempt: 2, nested: { sku: "abc" }, orderId: "o-1", paid: true },
                functionPath: "orders:place",
                level: "info",
                message: "order placed",
                spanId: "00f067aa0ba902b7",
                traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                ts: 1,
            });

            const { record } = logFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            // Primitive fields become typed attributes; a nested value is JSON-encoded.
            expect(attrValue(record.attributes, "orderId")).toStrictEqual({ stringValue: "o-1" });
            expect(attrValue(record.attributes, "attempt")).toStrictEqual({ intValue: "2" });
            expect(attrValue(record.attributes, "paid")).toStrictEqual({ boolValue: true });
            expect(attrValue(record.attributes, "nested")).toStrictEqual({ stringValue: '{"sku":"abc"}' });
            // Trace correlation (OTLP LogRecord.trace_id / span_id).
            expect(record.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
            expect(record.spanId).toBe("00f067aa0ba902b7");
        });

        it("emits a single attribute when a field reuses a reserved lunora.* key (field wins)", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onLog!({
                args: [],
                fields: { "lunora.user_id": "override" },
                functionPath: "a:b",
                level: "info",
                message: "m",
                ts: 1,
                userId: "real",
            });

            const { record } = logFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);
            const collisions = record.attributes.filter((attribute) => attribute.key === "lunora.user_id");

            // Exactly one `KeyValue` for the key — the caller's override, not a duplicate.
            expect(collisions).toHaveLength(1);
            expect(collisions[0]?.value).toStrictEqual({ stringValue: "override" });
        });

        it("tolerates a trailing slash on the endpoint", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example///" });

            sink.onRpc!(okEvent);

            const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(url).toBe("https://collector.example/v1/traces");
        });

        it("skips ok rpc spans when onlyErrors is set but still exports logs", () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example", onlyErrors: true });

            sink.onRpc!(okEvent);

            expect(fetchMock).not.toHaveBeenCalled();

            sink.onRpc!(errorEvent);

            expect(fetchMock).toHaveBeenCalledTimes(1);

            // onlyErrors scopes the RPC span stream, not developer log lines.
            sink.onLog!({ args: [], functionPath: "a:b", level: "info", message: "m", ts: 1 });

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it("merges auth and correlation headers onto a default content-type", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({
                endpoint: "https://collector.example",
                headers: { authorization: "Bearer tok", "x-lunora-deployment": "dep_1", "x-lunora-org": "org_1" },
            });

            sink.onRpc!(okEvent);

            const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(init.headers).toStrictEqual({
                authorization: "Bearer tok",
                "content-type": "application/json",
                "x-lunora-deployment": "dep_1",
                "x-lunora-org": "org_1",
            });
        });

        it("adds a Bearer token that overrides any authorization in headers", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({
                endpoint: "https://collector.example",
                headers: { Authorization: "Bearer stale" },
                token: "svc-token",
            });

            sink.onRpc!(okEvent);

            const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            const sentHeaders = init.headers as Record<string, string>;
            const authKeys = Object.keys(sentHeaders).filter((key) => key.toLowerCase() === "authorization");

            // The token wins over the stale header, without introducing a second key.
            expect(sentHeaders[authKeys[0]!]).toBe("Bearer svc-token");
            expect(authKeys).toHaveLength(1);
        });

        it("lets a differently-cased content-type override the default without duplicating it", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example", headers: { "Content-Type": "application/x-protobuf" } });

            sink.onRpc!(okEvent);

            const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            const sentHeaders = init.headers as Record<string, string>;

            expect(sentHeaders["content-type"]).toBe("application/x-protobuf");
            expect(Object.keys(sentHeaders).filter((key) => key.toLowerCase() === "content-type")).toHaveLength(1);
        });

        it("sets a custom service.name resource attribute on spans and logs", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example", serviceName: "checkout-api" });

            sink.onRpc!(okEvent);
            sink.onLog!({ args: [], functionPath: "a:b", level: "info", message: "m", ts: 1 });

            const { resourceAttributes: spanResource } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);
            const { resourceAttributes: logResource } = logFrom((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]);

            expect(attrValue(spanResource, "service.name")).toStrictEqual({ stringValue: "checkout-api" });
            expect(attrValue(logResource, "service.name")).toStrictEqual({ stringValue: "checkout-api" });
        });

        it("registers the send with ctx.waitUntil when a request context is provided", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onRpc!(okEvent, { waitUntil });

            expect(waitUntil).toHaveBeenCalledTimes(1);
            expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
        });

        it("posts a ctx.trace span as an INTERNAL span carrying its parent", () => {
            expect.assertions(7);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onSpan!(spanEvent);

            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(url).toBe("https://collector.example/v1/traces");

            const { span } = spanFrom(init);

            expect(span.name).toBe("stripe.charge");
            // SPAN_KIND_INTERNAL — a sub-operation inside the handler, not the request.
            expect(span.kind).toBe(1);
            // The parent link is what lets a collector nest this under the RPC span
            // instead of showing it as an orphan.
            expect(span.parentSpanId).toBe("b7ad6b7169203331");
            expect(span.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
            expect(span.status).toStrictEqual({ code: 1 });
            // The span covers exactly its own window, not the whole dispatch.
            // Compared as BigInt: a nanosecond timestamp is past 2^53, so a
            // `Number` subtraction would silently lose the low digits.
            expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBe(25_000_000n);
        });

        it("carries a ctx.trace span's attributes, letting a caller key override a reserved one", () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onSpan!({ ...spanEvent, attributes: { "lunora.shard_key": "override", orderId: "o-1" } });

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(attrValue(span.attributes, "orderId")).toStrictEqual({ stringValue: "o-1" });
            expect(attrValue(span.attributes, "lunora.shard_key")).toStrictEqual({ stringValue: "override" });
            // Overridden, not duplicated — a collector resolves duplicate keys ambiguously.
            expect(span.attributes.filter((entry) => entry.key === "lunora.shard_key")).toHaveLength(1);
        });

        it("encodes a failed ctx.trace span with its error type and status message", () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onSpan!({ ...spanEvent, error: { message: "card declined", type: "PAYMENT_FAILED" }, ok: false });

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(span.status.code).toBe(2);
            expect(span.status.message).toBe("card declined");
            expect(attrValue(span.attributes, "error.type")).toStrictEqual({ stringValue: "PAYMENT_FAILED" });
        });

        it("exports a ctx.trace span even under onlyErrors", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example", onlyErrors: true });

            sink.onSpan!(spanEvent);

            // `onlyErrors` scopes the RPC span stream; an explicitly instrumented
            // sub-operation is always exported, like `ctx.log` output.
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("swallows a rejected fetch", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => {
                throw new Error("collector down");
            });
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            expect(() => {
                sink.onRpc!(okEvent);
            }).not.toThrow();

            // Let the rejected promise settle without an unhandled rejection.
            await Promise.resolve();
        });

        it("swallows a synchronous fetch throw", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(() => {
                throw new Error("invalid url");
            });
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "not-a-url" });

            expect(() => {
                sink.onRpc!(okEvent);
            }).not.toThrow();
        });
    });

    describe("pipelineLogSink", () => {
        const logEvent: LogEvent = {
            args: ["order placed"],
            fields: { orderId: "o-1" },
            functionPath: "orders:place",
            level: "info",
            message: "order placed",
            shardKey: "tenant-1",
            spanId: "00f067aa0ba902b7",
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            ts: 1700,
            userId: "user-1",
        };

        it("sends one structured record per log line, keeping every carried field", () => {
            expect.assertions(2);

            const sent: Record<string, unknown>[][] = [];
            const sink = pipelineLogSink({
                pipeline: {
                    send: async (records) => {
                        sent.push(records);
                    },
                },
            });

            sink.onLog!(logEvent);

            expect(sent).toHaveLength(1);
            expect(sent[0]).toStrictEqual([
                {
                    fields: { orderId: "o-1" },
                    functionPath: "orders:place",
                    level: "info",
                    message: "order placed",
                    shardKey: "tenant-1",
                    spanId: "00f067aa0ba902b7",
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    ts: 1700,
                    userId: "user-1",
                },
            ]);
        });

        it("registers the send with the request's waitUntil so it survives teardown", () => {
            expect.assertions(1);

            const kept: Promise<unknown>[] = [];
            const sink = pipelineLogSink({ pipeline: { send: async () => undefined } });

            sink.onLog!(logEvent, {
                waitUntil: (promise) => {
                    kept.push(promise);
                },
            });

            expect(kept).toHaveLength(1);
        });

        it("swallows a rejecting or throwing pipeline so a log call can't break the handler", () => {
            expect.assertions(1);

            const sink = pipelineLogSink({
                pipeline: {
                    send: () => {
                        throw new Error("binding missing");
                    },
                },
            });

            expect(() => {
                sink.onLog!(logEvent);
            }).not.toThrow();
        });
    });
});
