import { gunzipSync } from "node:zlib";

import { isLunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogEvent, LogLevel, MetricEvent, ObservabilityEvent, ObservabilitySinkContext, SpanEvent } from "../src/observability";
import type { AnalyticsEngineDataPointLike } from "../src/observability-sinks";
import { analyticsEngineSink, combineSinks, consoleSink, otlpSink, pipelineLogSink, sentrySink, webhookSink } from "../src/observability-sinks";
import { createResourceAttributeResolver } from "../src/resource-detect";

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

/** One `ctx.metrics.count` measurement. */
const metricEvent: MetricEvent = {
    attributes: { plan: "pro" },
    functionPath: "orders:checkout",
    kind: "counter",
    name: "orders.placed",
    shardKey: "tenant-1",
    ts: 1_700_000_000_000,
    value: 2,
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
    events?: {
        attributes: OtlpKeyValue[];
        name: string;
        timeUnixNano: string;
    }[];
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

/**
 * Decode a POSTed OTLP body to JSON, transparently gunzipping the compressed
 * form. `otlpPost` gzips past `OTLP_GZIP_THRESHOLD`, and which side of that line
 * a body lands on shifts as attributes are added — so every decoder goes through
 * here rather than assuming a string body.
 */
const bodyJson = (init: RequestInit): string =>
    typeof init.body === "string" ? init.body : Buffer.from(gunzipSync(Buffer.from(init.body as ArrayBuffer))).toString("utf8");

/**
 * Wait until `fetchMock` has seen `count` OTLP posts.
 *
 * `otlpPost` sends synchronously below `OTLP_GZIP_THRESHOLD` and asynchronously
 * (after gzip) above it, and which side a body lands on shifts as attributes are
 * added — so reading `mock.calls` straight after `sink.onX()` is a latent
 * flake. Deliberately polls without `expect`, because `vi.waitFor` retries its
 * callback and any `expect` inside would make the test's assertion count
 * nondeterministic (which is what forced the weaker `expect.hasAssertions()`).
 */
const otlpCalls = async (fetchMock: { mock: { calls: unknown[] } }, count: number): Promise<void> => {
    await vi.waitFor(() => {
        if (fetchMock.mock.calls.length < count) {
            throw new Error(`expected ${String(count)} OTLP post(s), saw ${String(fetchMock.mock.calls.length)}`);
        }
    });
};

/** Look up an attribute's value by key. */
const attrValue = (attributes: OtlpKeyValue[], key: string): OtlpValue | undefined => attributes.find((entry) => entry.key === key)?.value;

/** Decode a POSTed OTLP trace-export body down to its single span + resource attributes. Handles gzip bodies. */
const spanFrom = (init: RequestInit): { resourceAttributes: OtlpKeyValue[]; scopeName: string; span: ParsedSpan } => {
    const json = bodyJson(init);
    const parsed = JSON.parse(json) as {
        resourceSpans: { resource: { attributes: OtlpKeyValue[] }; scopeSpans: { scope: { name: string }; spans: ParsedSpan[] }[] }[];
    };
    const resourceSpan = parsed.resourceSpans[0]!;
    const scopeSpan = resourceSpan.scopeSpans[0]!;

    return { resourceAttributes: resourceSpan.resource.attributes, scopeName: scopeSpan.scope.name, span: scopeSpan.spans[0]! };
};

/**
 * Read a POSTed body back to text, gunzipping when the sink compressed it.
 *
 * A batched export routinely clears the 1KB gzip threshold, so a batching test
 * that assumed a plain string body would be asserting on "[object ArrayBuffer]".
 */
const bodyText = async (init: RequestInit): Promise<string> => {
    const headers = init.headers as Record<string, string> | undefined;

    if (headers?.["content-encoding"] !== "gzip") {
        return init.body as string;
    }

    const stream = new Blob([init.body as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));

    return new Response(stream).text();
};

/** Decode a POSTed OTLP trace-export body down to ALL of its spans — the batched shape. */
const spansFrom = async (init: RequestInit): Promise<ParsedSpan[]> => {
    const parsed = JSON.parse(await bodyText(init)) as {
        resourceSpans: { scopeSpans: { spans: ParsedSpan[] }[] }[];
    };

    return parsed.resourceSpans[0]!.scopeSpans[0]!.spans;
};

/** The subset of an OTLP metric the tests assert on. */
interface ParsedMetric {
    gauge?: { dataPoints: { asDouble: number; attributes: OtlpKeyValue[] }[] };
    histogram?: {
        aggregationTemporality: number;
        dataPoints: { attributes: OtlpKeyValue[]; bucketCounts: string[]; count: string; explicitBounds: number[]; sum: number }[];
    };
    name: string;
    sum?: { aggregationTemporality: number; dataPoints: { asDouble: number; attributes: OtlpKeyValue[] }[]; isMonotonic: boolean };
}

/** Decode a POSTed OTLP metric-export body down to its metric **and** resource attributes. */
const metricExportFrom = (init: RequestInit): { metric: ParsedMetric; resourceAttributes: OtlpKeyValue[] } => {
    const parsed = JSON.parse(bodyJson(init)) as {
        resourceMetrics: { resource: { attributes: OtlpKeyValue[] }; scopeMetrics: { metrics: ParsedMetric[] }[] }[];
    };
    const resourceMetric = parsed.resourceMetrics[0]!;

    return { metric: resourceMetric.scopeMetrics[0]!.metrics[0]!, resourceAttributes: resourceMetric.resource.attributes };
};

/** Decode a POSTed OTLP metric-export body down to its single metric. */
const metricFrom = (init: RequestInit): ParsedMetric => metricExportFrom(init).metric;

/** Decode a POSTed OTLP log-export body down to its single log record + resource attributes. */
const logFrom = (init: RequestInit): { record: ParsedLogRecord; resourceAttributes: OtlpKeyValue[] } => {
    const json = bodyJson(init);
    const parsed = JSON.parse(json) as {
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
            const sink = sentrySink({ capture: vi.fn<(event: ObservabilityEvent) => void>(), captureLog });
            const logEvent: LogEvent = { args: [], fields: { orderId: "o-1" }, functionPath: "orders:place", level: "error", message: "boom", ts: 1 };

            sink.onLog!(logEvent);

            expect(captureLog).toHaveBeenCalledWith(logEvent);

            const throwing = sentrySink({
                capture: vi.fn<(event: ObservabilityEvent) => void>(),
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

            const sink = sentrySink({ capture: vi.fn<(event: ObservabilityEvent) => void>() });

            expect(sink.onLog).toBeUndefined();
        });

        it("throws at construction when `capture` is missing instead of swallowing every event", () => {
            expect.assertions(2);

            expect(() => sentrySink({ dsn: "https://key@o0.ingest.sentry.io/0" } as unknown as Parameters<typeof sentrySink>[0])).toThrow(
                /requires a `capture` callback/u,
            );
            expect(() => sentrySink({} as unknown as Parameters<typeof sentrySink>[0])).toThrow(TypeError);
        });
    });

    describe("combineSinks", () => {
        it("forwards flush to every batching child", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const plain = vi.fn<(event: ObservabilityEvent) => void>();
            // The documented pairing: a batching network sink behind combineSinks
            // alongside a non-batching one.
            const sink = combineSinks(otlpSink({ endpoint: "https://collector.example" }), { onRpc: plain });

            sink.onRpc!(okEvent);

            expect(fetchMock).toHaveBeenCalledTimes(0);

            const pending: Promise<unknown>[] = [];

            sink.flush!({
                waitUntil: (promise) => {
                    pending.push(promise);
                },
            });
            await Promise.all(pending);

            // Without flush fan-out the wrapped sink never ships at the invocation
            // boundary, and its buffer dies with the isolate.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(plain).toHaveBeenCalledTimes(1);

            vi.unstubAllGlobals();
        });

        it("tolerates a child with no flush", () => {
            expect.assertions(1);

            const sink = combineSinks({ onRpc: vi.fn<(event: ObservabilityEvent) => void>() });

            expect(() => {
                sink.flush!();
            }).not.toThrow();
        });

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

        it("carries the sink CONFIG fields through, not just the callbacks", () => {
            expect.assertions(4);

            // `fuseCloudflareTraces` / `instrumentDatabase` / `metricHistory` /
            // `traceFetch` are read off the sink OBJECT by `@lunora/do`, not through
            // a hook. Returning only the five callbacks silently dropped them — so
            // a combined sink with a `traceFetch.propagate` predicate reverted to
            // the `true` default and injected `traceparent` into every outbound
            // `ctx.fetch`, third-party hosts included.
            const propagate = (url: URL): boolean => url.host.endsWith(".internal");
            const sink = combineSinks(
                { fuseCloudflareTraces: true, onRpc: vi.fn<(event: ObservabilityEvent) => void>(), traceFetch: { propagate } },
                { instrumentDatabase: "spans", metricHistory: true, onRpc: vi.fn<(event: ObservabilityEvent) => void>() },
            );

            expect(sink.traceFetch).toStrictEqual({ propagate });
            expect(sink.fuseCloudflareTraces).toBe(true);
            expect(sink.instrumentDatabase).toBe("spans");
            expect(sink.metricHistory).toBe(true);
        });

        it("resolves a config field first-wins, and leaves it undefined when no child sets it", () => {
            expect.assertions(2);

            const sink = combineSinks({ instrumentDatabase: "off" }, { instrumentDatabase: "spans" });

            expect(sink.instrumentDatabase).toBe("off");
            expect(combineSinks({ onRpc: vi.fn<(event: ObservabilityEvent) => void>() }).traceFetch).toBeUndefined();
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

    // These cover the OTLP *encoding* — one event in, one well-formed body out —
    // so they pin `batch: false`. Batching is what the sink does by DEFAULT and is
    // covered separately in "otlpSink batching" below; asserting a synchronous
    // `fetch` per event would otherwise be testing the buffer's timing, not the wire
    // format.
    describe("otlpSink", () => {
        afterEach(() => {
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        });

        it("posts a well-formed OTLP span to the traces endpoint for an ok rpc event", () => {
            expect.assertions(9);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

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

        it("reuses the dispatch's trace/span ids when the event carries them", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onRpc!({ ...okEvent, spanId: "b7ad6b7169203331", traceId: "0af7651916cd43dd8448eb211c80319c" });

            await otlpCalls(fetchMock, 1);

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            // The span rides the ids the runtime propagated as `traceparent`, not fresh ones.
            expect(span.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
            expect(span.spanId).toBe("b7ad6b7169203331");
        });

        it("encodes error status, error.type, and the status message for a failed event", async () => {
            expect.assertions(5);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onRpc!(errorEvent);
            await otlpCalls(fetchMock, 1);

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            // STATUS_CODE_ERROR carries the human-readable message.
            expect(span.status).toStrictEqual({ code: 2, message: "boom: user@example.com" });
            expect(attrValue(span.attributes, "error.type")).toStrictEqual({ stringValue: "CONFLICT" });
            expect(attrValue(span.attributes, "lunora.error_status")).toStrictEqual({ intValue: "409" });
            expect(attrValue(span.attributes, "lunora.ok")).toStrictEqual({ boolValue: false });
            // Exception event records the error under OTel semantics.
            expect(span.events).toStrictEqual([
                {
                    attributes: [
                        { key: "exception.type", value: { stringValue: "CONFLICT" } },
                        { key: "exception.message", value: { stringValue: "boom: user@example.com" } },
                    ],
                    name: "exception",
                    timeUnixNano: span.endTimeUnixNano,
                },
            ]);
        });

        it("derives span start and end from durationMs at nanosecond precision", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onRpc!(okEvent);

            await otlpCalls(fetchMock, 1);

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(span.startTimeUnixNano).toMatch(UNIX_NANO);
            expect(span.endTimeUnixNano).toMatch(UNIX_NANO);
            // end - start must equal durationMs (5ms) in nanos, exactly — BigInt
            // avoids the double-rounding a ~1.7e18 nanosecond value would suffer.
            expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBe(BigInt(5 * 1_000_000));
        });

        it("records fan-out cardinality and the aggregated table as attributes", async () => {
            expect.assertions(4);

            const fanOutEvent: ObservabilityEvent = {
                durationMs: 12,
                fanOut: { failed: 1, shards: 4, table: "messages" },
                functionPath: "messages:countAll",
                ok: true,
            };
            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onRpc!(fanOutEvent);

            await otlpCalls(fetchMock, 1);

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

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

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

        // `maxItems` is operator config, and both bad shapes are unrecoverable at
        // runtime rather than merely wrong: a negative cap makes the batcher's
        // drop-oldest `while` spin forever on the first buffered event (the
        // isolate hangs on its first `ctx.log`), and `0`/`0.5` empty the buffer
        // before the drain reads it, so every signal is discarded in silence.
        it.each([-1, 0, 0.5])("refuses to construct with batch.maxItems %p", (maxItems) => {
            expect.assertions(2);

            let thrown: unknown;

            try {
                otlpSink({ batch: { maxItems }, endpoint: "https://collector.example" });
            } catch (error) {
                thrown = error;
            }

            expect(isLunoraError(thrown)).toBe(true);
            expect((thrown as { code?: string }).code).toBe("ENV_INVALID");
        });

        // The console/Logpush line already redacts a log's `fields`, and the span
        // pipeline already redacts error messages — a collector is the sink with
        // third-party fan-out, so it must not be the one that sees MORE.
        it("redacts a log record's fields and message before exporting them", () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onLog!({
                args: [],
                fields: { orderId: "o-1", password: "hunter2" },
                functionPath: "orders:place",
                level: "info",
                message: "charged buyer@example.com",
                ts: 1,
            });

            const { record } = logFrom(fetchMock.mock.calls[0]![1] as RequestInit);

            expect(attrValue(record.attributes, "password")).not.toStrictEqual({ stringValue: "hunter2" });
            // A field with no secret-shaped name and no PII pattern is untouched —
            // this is a redactor, not a blunt drop-everything.
            expect(attrValue(record.attributes, "orderId")).toStrictEqual({ stringValue: "o-1" });
            expect(record.body.stringValue).not.toContain("buyer@example.com");
        });

        it("ships the raw log record when redactLogs is opted out", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example", redactLogs: false });

            sink.onLog!({
                args: [],
                fields: { password: "hunter2" },
                functionPath: "orders:place",
                level: "info",
                message: "charged buyer@example.com",
                ts: 1,
            });

            const { record } = logFrom(fetchMock.mock.calls[0]![1] as RequestInit);

            expect(attrValue(record.attributes, "password")).toStrictEqual({ stringValue: "hunter2" });
            expect(record.body.stringValue).toBe("charged buyer@example.com");
        });

        it("maps each log level to its OTLP severity number", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });
            const levels: LogLevel[] = ["trace", "debug", "info", "log", "warn", "error", "fatal"];

            for (const level of levels) {
                sink.onLog!({ args: [], functionPath: "a:b", level, message: "m", ts: 1 });
            }

            const numbers = fetchMock.mock.calls.map((call) => logFrom(call[1] as RequestInit).record.severityNumber);

            // trace=TRACE(1), debug=DEBUG(5), info=INFO(9), log→INFO(9), warn=WARN(13), error=ERROR(17), fatal=FATAL(21).
            expect(numbers).toStrictEqual([1, 5, 9, 9, 13, 17, 21]);
        });

        it("maps structured fields onto log-record attributes and correlates the record to its trace", async () => {
            expect.assertions(6);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

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

            await otlpCalls(fetchMock, 1);

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

        it("emits a single attribute when a field reuses a reserved lunora.* key (field wins)", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onLog!({
                args: [],
                fields: { "lunora.user_id": "override" },
                functionPath: "a:b",
                level: "info",
                message: "m",
                ts: 1,
                userId: "real",
            });

            await otlpCalls(fetchMock, 1);

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

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example///" });

            sink.onRpc!(okEvent);

            const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(url).toBe("https://collector.example/v1/traces");
        });

        it("skips ok rpc spans when onlyErrors is set but still exports logs", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example", onlyErrors: true });

            sink.onRpc!(okEvent);

            expect(fetchMock).not.toHaveBeenCalled();

            sink.onRpc!(errorEvent);
            await otlpCalls(fetchMock, 1);

            // onlyErrors scopes the RPC span stream, not developer log lines.
            sink.onLog!({ args: [], functionPath: "a:b", level: "info", message: "m", ts: 1 });
            await otlpCalls(fetchMock, 2);
        });

        it("merges auth and correlation headers onto a default content-type", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({
                batch: false,
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
                batch: false,
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

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example", headers: { "Content-Type": "application/x-protobuf" } });

            sink.onRpc!(okEvent);

            const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            const sentHeaders = init.headers as Record<string, string>;

            expect(sentHeaders["content-type"]).toBe("application/x-protobuf");
            expect(Object.keys(sentHeaders).filter((key) => key.toLowerCase() === "content-type")).toHaveLength(1);
        });

        it("sets a custom service.name resource attribute on spans and logs", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example", serviceName: "checkout-api" });

            sink.onRpc!(okEvent);
            sink.onLog!({ args: [], functionPath: "a:b", level: "info", message: "m", ts: 1 });

            await otlpCalls(fetchMock, 2);

            const { resourceAttributes: spanResource } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);
            const { resourceAttributes: logResource } = logFrom((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]);

            expect(attrValue(spanResource, "service.name")).toStrictEqual({ stringValue: "checkout-api" });
            expect(attrValue(logResource, "service.name")).toStrictEqual({ stringValue: "checkout-api" });
        });

        it("emits configured OTLP resource attributes on spans, logs, and metrics", async () => {
            expect.assertions(8);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({
                deploymentEnvironment: "production",
                endpoint: "https://collector.example",
                resourceAttributes: { "host.name": "worker-1", "service.instance.id": "i-abc" },
                serviceName: "checkout-api",
                serviceNamespace: "lunora",
                serviceVersion: "v1.2.3",
            });

            sink.onRpc!(okEvent);
            sink.onLog!({ args: [], functionPath: "a:b", level: "info", message: "m", ts: 1 });
            sink.onMetric!(metricEvent);

            await otlpCalls(fetchMock, 3);

            const { resourceAttributes: spanResource } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);
            const { resourceAttributes: logResource } = logFrom((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]);
            const { metric, resourceAttributes: metricResource } = metricExportFrom((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1]);

            // service.name is always present; convenience fields + custom resourceAttributes are merged.
            expect(attrValue(spanResource, "service.name")).toStrictEqual({ stringValue: "checkout-api" });
            expect(attrValue(spanResource, "service.version")).toStrictEqual({ stringValue: "v1.2.3" });
            expect(attrValue(spanResource, "service.namespace")).toStrictEqual({ stringValue: "lunora" });
            expect(attrValue(spanResource, "deployment.environment")).toStrictEqual({ stringValue: "production" });
            expect(attrValue(spanResource, "host.name")).toStrictEqual({ stringValue: "worker-1" });
            expect(attrValue(logResource, "service.instance.id")).toStrictEqual({ stringValue: "i-abc" });
            // The metric envelope carries the same resource, not just datapoint attributes.
            expect(attrValue(metricResource, "service.version")).toStrictEqual({ stringValue: "v1.2.3" });
            expect(attrValue(metric.sum!.dataPoints[0]!.attributes, "plan")).toStrictEqual({ stringValue: "pro" });
        });

        // `otlpMetricBody` wraps the resource at three separate return sites (gauge,
        // histogram, sum); only the sum branch was covered, so a resource dropped
        // from either of the others would have shipped silently.
        it.each(["counter", "gauge", "histogram"] as const)("attaches the resource to a %s metric export", async (kind) => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example", serviceName: "checkout-api", serviceVersion: "v1.2.3" });

            sink.onMetric!({ ...metricEvent, kind });

            await otlpCalls(fetchMock, 1);

            const { resourceAttributes } = metricExportFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(attrValue(resourceAttributes, "service.name")).toStrictEqual({ stringValue: "checkout-api" });
            expect(attrValue(resourceAttributes, "service.version")).toStrictEqual({ stringValue: "v1.2.3" });
        });

        it("lets resourceAttributes override built-in resource attributes", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example", resourceAttributes: { "service.name": "overridden" }, serviceName: "checkout-api" });

            sink.onRpc!(okEvent);

            await otlpCalls(fetchMock, 1);

            const { resourceAttributes } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(attrValue(resourceAttributes, "service.name")).toStrictEqual({ stringValue: "overridden" });
        });

        it("emits HTTP semantic-convention attributes on the RPC dispatch span", async () => {
            expect.assertions(9);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onRpc!({
                ...okEvent,
                host: "api.example.com",
                method: "POST",
                path: "/_lunora/rpc",
                port: 443,
                scheme: "https",
                userAgent: "test-agent/1.0",
            });
            await otlpCalls(fetchMock, 1);

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(attrValue(span.attributes, "http.request.method")).toStrictEqual({ stringValue: "POST" });
            expect(attrValue(span.attributes, "url.path")).toStrictEqual({ stringValue: "/_lunora/rpc" });
            expect(attrValue(span.attributes, "url.scheme")).toStrictEqual({ stringValue: "https" });
            expect(attrValue(span.attributes, "server.address")).toStrictEqual({ stringValue: "api.example.com" });
            expect(attrValue(span.attributes, "server.port")).toStrictEqual({ intValue: "443" });
            expect(attrValue(span.attributes, "user_agent.original")).toStrictEqual({ stringValue: "test-agent/1.0" });
            expect(attrValue(span.attributes, "http.route")).toStrictEqual({ stringValue: "messages:list" });
            expect(attrValue(span.attributes, "lunora.function_path")).toStrictEqual({ stringValue: "messages:list" });
            expect(attrValue(span.attributes, "http.response.status_code")).toStrictEqual({ intValue: "200" });
        });

        it("emits http.response.status_code on the RPC span for failed events", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onRpc!({ ...errorEvent, method: "POST", path: "/_lunora/rpc" });
            await otlpCalls(fetchMock, 1);

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(attrValue(span.attributes, "http.response.status_code")).toStrictEqual({ intValue: "409" });
            expect(attrValue(span.attributes, "http.request.method")).toStrictEqual({ stringValue: "POST" });
        });

        it("auto-detects Cloudflare Worker resource attributes when detectResources is true", async () => {
            expect.assertions(5);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const request = new Request("https://api.example.com/_lunora/rpc", { headers: { "user-agent": "cloudflare" } });
            // Attach the Cloudflare `cf` object so the detector sees a Workers request.
            Object.defineProperty(request, "cf", { value: { colo: "SFO" }, writable: false });

            const sink = otlpSink({ detectResources: true, endpoint: "https://collector.example", serviceName: "checkout-api" });

            sink.onRpc!(okEvent, {
                resourceAttributes: createResourceAttributeResolver({ CF_ACCOUNT_ID: "abc", ENVIRONMENT: "production", SERVICE_VERSION: "v1.2.3" }, request),
                waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
            });

            await otlpCalls(fetchMock, 1);

            const { resourceAttributes } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(attrValue(resourceAttributes, "service.name")).toStrictEqual({ stringValue: "checkout-api" });
            expect(attrValue(resourceAttributes, "service.version")).toStrictEqual({ stringValue: "v1.2.3" });
            expect(attrValue(resourceAttributes, "deployment.environment")).toStrictEqual({ stringValue: "production" });
            expect(attrValue(resourceAttributes, "cloud.provider")).toStrictEqual({ stringValue: "cloudflare" });
            expect(attrValue(resourceAttributes, "cloud.region")).toStrictEqual({ stringValue: "SFO" });
        });

        it("lets explicit resource attributes override detected ones", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({
                deploymentEnvironment: "staging",
                detectResources: true,
                endpoint: "https://collector.example",
                resourceAttributes: { "cloud.region": "overridden-region" },
            });

            sink.onRpc!(okEvent, {
                resourceAttributes: createResourceAttributeResolver(
                    { CF_ACCOUNT_ID: "abc", CF_COLO: "SFO", ENVIRONMENT: "production" },
                    new Request("https://api.example.com/_lunora/rpc"),
                ),
                waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
            });

            await otlpCalls(fetchMock, 1);

            const { resourceAttributes } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(attrValue(resourceAttributes, "cloud.region")).toStrictEqual({ stringValue: "overridden-region" });
        });

        it("collapses byte-identical resource bags from different requests into one export call", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            // Batched (default) with detection on: `resourceAttributesFor` memoizes
            // its merged bag per request context, so two requests in one flush window
            // produce two DISTINCT object instances with identical content. Keyed by
            // object identity that was two envelopes / two `fetch` calls; keyed by a
            // stable serialization it is one call carrying both spans.
            const sink = otlpSink({ detectResources: true, endpoint: "https://collector.example" });

            const contextFor = (): ObservabilitySinkContext => {
                return {
                    resourceAttributes: () => {
                        return { "host.name": "worker-1" };
                    },
                    waitUntil: () => undefined,
                };
            };

            sink.onRpc!(okEvent, contextFor());
            sink.onRpc!({ ...okEvent, functionPath: "messages:send" }, contextFor());

            const pending: Promise<unknown>[] = [];

            sink.flush!({
                waitUntil: (promise) => {
                    pending.push(promise);
                },
            });
            await Promise.all(pending);

            expect(fetchMock).toHaveBeenCalledTimes(1);

            const spans = await spansFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(spans).toHaveLength(2);
        });

        it("registers the send with ctx.waitUntil when a request context is provided", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onRpc!(okEvent, { waitUntil });

            expect(waitUntil).toHaveBeenCalledTimes(1);
            expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
        });

        it("posts a ctx.trace span as an INTERNAL span carrying its parent", () => {
            expect.assertions(7);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

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

        it("carries a ctx.trace span's attributes, letting a caller key override a reserved one", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onSpan!({ ...spanEvent, attributes: { "lunora.shard_key": "override", orderId: "o-1" } });

            await otlpCalls(fetchMock, 1);

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(attrValue(span.attributes, "orderId")).toStrictEqual({ stringValue: "o-1" });
            expect(attrValue(span.attributes, "lunora.shard_key")).toStrictEqual({ stringValue: "override" });
            // Overridden, not duplicated — a collector resolves duplicate keys ambiguously.
            expect(span.attributes.filter((entry) => entry.key === "lunora.shard_key")).toHaveLength(1);
        });

        it("encodes a failed ctx.trace span with its error type and status message", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onSpan!({ ...spanEvent, error: { message: "card declined", type: "PAYMENT_FAILED" }, ok: false });

            await otlpCalls(fetchMock, 1);

            const { span } = spanFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(span.status.code).toBe(2);
            expect(span.status.message).toBe("card declined");
            expect(attrValue(span.attributes, "error.type")).toStrictEqual({ stringValue: "PAYMENT_FAILED" });
        });

        it("exports a counter as a monotonic delta Sum", () => {
            expect.assertions(6);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onMetric!(metricEvent);

            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(url).toBe("https://collector.example/v1/metrics");

            const metric = metricFrom(init);

            expect(metric.name).toBe("orders.placed");
            expect(metric.sum?.isMonotonic).toBe(true);
            // DELTA (1) — the runtime pre-aggregates nothing, so the collector sums.
            expect(metric.sum?.aggregationTemporality).toBe(1);
            expect(metric.sum?.dataPoints[0]?.asDouble).toBe(2);
            expect(attrValue(metric.sum!.dataPoints[0]!.attributes, "plan")).toStrictEqual({ stringValue: "pro" });
        });

        it("exports a gauge as a Gauge with no temporality", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onMetric!({ ...metricEvent, kind: "gauge", name: "cart.items", value: 7 });

            await otlpCalls(fetchMock, 1);

            const metric = metricFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);

            expect(metric.name).toBe("cart.items");
            expect(metric.gauge?.dataPoints[0]?.asDouble).toBe(7);
            // A reading replaces the previous one — temporality does not apply.
            expect(metric.sum).toBeUndefined();
        });

        it("exports a histogram sample as a single-observation delta data point", async () => {
            expect.assertions(5);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onMetric!({ ...metricEvent, kind: "histogram", name: "checkout.latency_ms", value: 128 });

            await otlpCalls(fetchMock, 1);

            const metric = metricFrom((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]);
            const point = metric.histogram?.dataPoints[0];

            expect(metric.histogram?.aggregationTemporality).toBe(1);
            expect(point?.count).toBe("1");
            expect(point?.sum).toBe(128);
            // One implicit bucket: the collector builds the distribution from the
            // stream, so the runtime never has to pick bounds for the user.
            expect(point?.explicitBounds).toStrictEqual([]);
            expect(point?.bucketCounts).toStrictEqual(["1"]);
        });

        it("exports a ctx.trace span even under onlyErrors", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example", onlyErrors: true });

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

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

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

            const sink = otlpSink({ batch: false, endpoint: "not-a-url" });

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

        it("serializes `fields` to a JSON string when serializeFields is on", () => {
            expect.assertions(1);

            const sent: Record<string, unknown>[][] = [];
            const sink = pipelineLogSink({
                pipeline: {
                    send: async (records) => {
                        sent.push(records);
                    },
                },
                serializeFields: true,
            });

            sink.onLog!(logEvent);

            // `fields` lands as a queryable JSON string (the reader parses it back).
            expect(sent[0]?.[0]?.fields).toBe(JSON.stringify({ orderId: "o-1" }));
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

    /**
     * The DEFAULT path: events are buffered and shipped as one request per signal
     * at the invocation boundary. This is what keeps a well-instrumented handler
     * from spending its Workers subrequest budget (50 free / 1000 paid) on
     * telemetry, and it is what makes real tail sampling possible.
     */
    describe("otlpSink batching", () => {
        afterEach(() => {
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        });

        it("buffers events and ships them as ONE request per signal on flush", async () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onRpc!(okEvent);
            sink.onSpan!(spanEvent);
            sink.onSpan!({ ...spanEvent, name: "db.read", spanId: "1111111111111111" });

            // Nothing has left yet: that is the whole point of buffering.
            expect(fetchMock).toHaveBeenCalledTimes(0);

            const pending: Promise<unknown>[] = [];

            sink.flush!({
                waitUntil: (promise) => {
                    pending.push(promise);
                },
            });

            await Promise.all(pending);

            // Three spans, ONE POST — not three.
            expect(fetchMock).toHaveBeenCalledTimes(1);

            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(url).toBe("https://collector.example/v1/traces");
            await expect(spansFrom(init)).resolves.toHaveLength(3);
        });

        it("splits the flush across the three signal endpoints", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.onSpan!(spanEvent);
            sink.onLog!({ args: [], functionPath: "a:b", level: "info", message: "m", ts: 1 });
            sink.onMetric!(metricEvent);

            const pending: Promise<unknown>[] = [];

            sink.flush!({
                waitUntil: (promise) => {
                    pending.push(promise);
                },
            });
            await Promise.all(pending);

            // OTLP has no combined envelope, so three signals means three URLs —
            // but still only one request each, regardless of event count.
            expect(fetchMock).toHaveBeenCalledTimes(3);
            expect(new Set(fetchMock.mock.calls.map((call) => call[0]))).toStrictEqual(
                new Set(["https://collector.example/v1/logs", "https://collector.example/v1/metrics", "https://collector.example/v1/traces"]),
            );
        });

        it("flushes early once maxItems is reached, without waiting", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: { maxItems: 2 }, endpoint: "https://collector.example" });

            sink.onSpan!(spanEvent);
            sink.onSpan!(spanEvent);

            // No `flush()` and no timer wait: hitting the cap drains immediately,
            // which is what bounds both the body size and the buffer's memory.
            await vi.waitFor(() => {
                if (fetchMock.mock.calls.length === 0) {
                    throw new Error("not flushed yet");
                }
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("keeps a whole trace when the tail sampler accepts it", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({
                endpoint: "https://collector.example",
                // The canonical policy head sampling cannot express: keep it if
                // anything in the trace was slow.
                tailSampler: ({ spans }) => spans.some((span) => span.durationMs > 20),
            });

            sink.onSpan!(spanEvent);

            const pending: Promise<unknown>[] = [];

            sink.flush!({
                waitUntil: (promise) => {
                    pending.push(promise);
                },
            });
            await Promise.all(pending);

            expect(fetchMock).toHaveBeenCalledTimes(1);
            await expect(spansFrom(fetchMock.mock.calls[0]![1] as RequestInit)).resolves.toHaveLength(1);
        });

        it("drops a whole trace — spans AND its logs — when the tail sampler rejects it", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example", tailSampler: () => false });

            sink.onSpan!(spanEvent);
            sink.onLog!({ args: [], functionPath: "a:b", level: "info", message: "m", traceId: spanEvent.traceId, ts: 1 });

            const pending: Promise<unknown>[] = [];

            sink.flush!({
                waitUntil: (promise) => {
                    pending.push(promise);
                },
            });
            await Promise.all(pending);

            // A dropped trace must take its correlated logs with it, or the
            // backend keeps orphan lines pointing at a trace that does not exist.
            expect(fetchMock).toHaveBeenCalledTimes(0);
        });

        it("keeps events that carry no trace id, which the sampler cannot judge", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example", tailSampler: () => false });

            // A metric has no trace, so there is nothing for a TRACE sampler to
            // reject — dropping it would silently discard a measurement the
            // developer explicitly recorded.
            sink.onMetric!(metricEvent);

            const pending: Promise<unknown>[] = [];

            sink.flush!({
                waitUntil: (promise) => {
                    pending.push(promise);
                },
            });
            await Promise.all(pending);

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("applies the post-processor before encoding, and drops on undefined", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({
                endpoint: "https://collector.example",
                postProcessor: {
                    log: () => undefined,
                    span: (event) => {
                        return { ...event, attributes: { ...event.attributes, email: "[redacted]" } };
                    },
                },
            });

            sink.onSpan!({ ...spanEvent, attributes: { email: "user@example.com" } });
            sink.onLog!({ args: [], functionPath: "a:b", level: "info", message: "secret", ts: 1 });

            const pending: Promise<unknown>[] = [];

            sink.flush!({
                waitUntil: (promise) => {
                    pending.push(promise);
                },
            });
            await Promise.all(pending);

            // Logs were dropped wholesale, so only the traces endpoint was hit.
            expect(fetchMock).toHaveBeenCalledTimes(1);

            const { span } = spanFrom(fetchMock.mock.calls[0]![1] as RequestInit);

            expect(attrValue(span.attributes, "email")).toStrictEqual({ stringValue: "[redacted]" });
        });

        it("drops the event when a post-processor hook throws", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({
                endpoint: "https://collector.example",
                postProcessor: {
                    span: () => {
                        throw new Error("bad redaction rule");
                    },
                },
            });

            sink.onSpan!(spanEvent);

            const pending: Promise<unknown>[] = [];

            sink.flush!({
                waitUntil: (promise) => {
                    pending.push(promise);
                },
            });
            await Promise.all(pending);

            // Fails CLOSED: `postProcessor` is the PII seam, so a broken rule must
            // lose the span rather than ship the payload it existed to scrub.
            expect(fetchMock).toHaveBeenCalledTimes(0);
        });

        it("keeps the trace when the tail sampler itself throws", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({
                endpoint: "https://collector.example",
                tailSampler: () => {
                    throw new Error("bad policy");
                },
            });

            sink.onSpan!(spanEvent);

            const pending: Promise<unknown>[] = [];

            sink.flush!({
                waitUntil: (promise) => {
                    pending.push(promise);
                },
            });
            await Promise.all(pending);

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("reports a throwing tail sampler once per flush window, not once per trace", async () => {
            expect.assertions(2);

            vi.stubGlobal(
                "fetch",
                vi.fn<typeof fetch>(async () => new Response("ok")),
            );

            const errorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const sink = otlpSink({
                endpoint: "https://collector.example",
                tailSampler: () => {
                    throw new Error("bad policy");
                },
            });

            // Three distinct traces in one window: fail-open is per trace, but the
            // operator only needs telling once that the policy stopped applying.
            sink.onSpan!({ ...spanEvent, traceId: "0af7651916cd43dd8448eb211c80319c" });
            sink.onSpan!({ ...spanEvent, traceId: "1af7651916cd43dd8448eb211c80319c" });
            sink.onSpan!({ ...spanEvent, traceId: "2af7651916cd43dd8448eb211c80319c" });

            const pending: Promise<unknown>[] = [];

            sink.flush!({
                waitUntil: (promise) => {
                    pending.push(promise);
                },
            });
            await Promise.all(pending);

            expect(errorMock).toHaveBeenCalledTimes(1);
            expect(errorMock.mock.calls[0]?.[0]).toContain("3 trace(s)");
        });

        it("stops reporting tail-sampler failures after the per-sink cap", async () => {
            expect.assertions(2);

            vi.stubGlobal(
                "fetch",
                vi.fn<typeof fetch>(async () => new Response("ok")),
            );

            const errorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const sink = otlpSink({
                endpoint: "https://collector.example",
                tailSampler: () => {
                    throw new Error("bad policy");
                },
            });

            // A sampler that throws throws on every window; the diagnostic must not
            // become the log volume that sampling exists to hold down.
            for (let index = 0; index < 12; index += 1) {
                const pending: Promise<unknown>[] = [];

                sink.onSpan!(spanEvent);
                sink.flush!({
                    waitUntil: (promise) => {
                        pending.push(promise);
                    },
                });
                // eslint-disable-next-line no-await-in-loop
                await Promise.all(pending);
            }

            expect(errorMock).toHaveBeenCalledTimes(5);
            expect(errorMock.mock.calls[4]?.[0]).toContain("silenced");
        });

        it("is a no-op to flush an empty buffer", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ endpoint: "https://collector.example" });

            sink.flush!();

            expect(fetchMock).toHaveBeenCalledTimes(0);
        });
    });

    describe("otlpSink span model", () => {
        afterEach(() => {
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        });

        it("encodes an explicit span kind, defaulting to INTERNAL", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onSpan!({ ...spanEvent, kind: "client" });
            sink.onSpan!(spanEvent);

            // SPAN_KIND_CLIENT (3) — what lets a collector draw the edge to the
            // downstream service in a service map.
            expect(spanFrom(fetchMock.mock.calls[0]![1] as RequestInit).span.kind).toBe(3);
            expect(spanFrom(fetchMock.mock.calls[1]![1] as RequestInit).span.kind).toBe(1);
        });

        it("encodes span events and links, and omits them entirely when empty", () => {
            expect.assertions(5);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onSpan!({
                ...spanEvent,
                events: [{ attributes: { attempts: 2 }, name: "payment.retried", ts: 1_700_000_000_100 }],
                links: [{ attributes: { "link.kind": "enqueued_by" }, spanId: "aaaaaaaaaaaaaaaa", traceId: "b".repeat(32) }],
            });
            sink.onSpan!(spanEvent);

            const withExtras = spanFrom(fetchMock.mock.calls[0]![1] as RequestInit).span as ParsedSpan & {
                events?: { attributes: OtlpKeyValue[]; name: string; timeUnixNano: string }[];
                links?: { spanId: string; traceId: string }[];
            };

            expect(withExtras.events).toHaveLength(1);
            expect(withExtras.events![0]!.name).toBe("payment.retried");
            expect(withExtras.links![0]!.spanId).toBe("aaaaaaaaaaaaaaaa");

            const plain = spanFrom(fetchMock.mock.calls[1]![1] as RequestInit).span as ParsedSpan & { events?: unknown; links?: unknown };

            // Omitted, not `[]`: an ordinary span stays byte-identical to what
            // this encoder produced before events and links existed.
            expect(plain.events).toBeUndefined();
            expect(plain.links).toBeUndefined();
        });

        it("carries the upstream parent on an RPC span only when one was accepted", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onRpc!({ ...okEvent, parentSpanId: "b7ad6b7169203331" });
            sink.onRpc!(okEvent);

            expect(spanFrom(fetchMock.mock.calls[0]![1] as RequestInit).span.parentSpanId).toBe("b7ad6b7169203331");
            // Self-originated: stays the root rather than dangling off a parent
            // that was never exported.
            expect(spanFrom(fetchMock.mock.calls[1]![1] as RequestInit).span.parentSpanId).toBeUndefined();
        });

        it("marks a ctx.log.event line as an OTel Event in both spellings", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = otlpSink({ batch: false, endpoint: "https://collector.example" });

            sink.onLog!({
                args: ["checkout.completed"],
                eventName: "checkout.completed",
                fields: { plan: "pro" },
                functionPath: "orders:checkout",
                level: "info",
                message: "checkout.completed",
                ts: 1,
            });

            const init = fetchMock.mock.calls[0]![1] as RequestInit;
            const { record } = logFrom(init);

            // `eventName` is the proto >= 1.5 field; the `event.name` attribute is
            // how collectors recognised events before it. Emitting only one loses
            // the event's identity on half the pipelines in the wild.
            expect((record as ParsedLogRecord & { eventName?: string }).eventName).toBe("checkout.completed");
            expect(attrValue(record.attributes, "event.name")).toStrictEqual({ stringValue: "checkout.completed" });
        });
    });
});
