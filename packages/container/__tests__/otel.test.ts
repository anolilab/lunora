import { afterEach, describe, expect, it, vi } from "vitest";

import type { OtelFetchLike } from "../src/otel";
import { createContainerTelemetry } from "../src/otel";

/** One OTLP `AnyValue`, as decoded from a POSTed body. */
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

/** A decoded OTLP span. */
interface ParsedSpan {
    attributes: OtlpKeyValue[];
    endTimeUnixNano: string;
    flags?: number;
    kind: number;
    name: string;
    parentSpanId?: string;
    spanId: string;
    startTimeUnixNano: string;
    status: { code: number; message?: string };
    traceId: string;
}

/** A decoded OTLP log record. */
interface ParsedLogRecord {
    attributes: OtlpKeyValue[];
    body: { stringValue: string };
    flags?: number;
    severityNumber: number;
    severityText: string;
    spanId?: string;
    timeUnixNano: string;
    traceId?: string;
}

const TRACE_ID_HEX = /^[0-9a-f]{32}$/;
const SPAN_ID_HEX = /^[0-9a-f]{16}$/;
const UNIX_NANO = /^\d+000000$/;

/** A fetch stub recording every request; resolves `{ ok, status }`. */
const stubFetch = (
    init: { ok?: boolean; status?: number } = {},
): { calls: { body: string; headers: Record<string, string>; url: string }[]; fetch: OtelFetchLike } => {
    const calls: { body: string; headers: Record<string, string>; url: string }[] = [];

    const fetch: OtelFetchLike = async (url, requestInit) => {
        calls.push({ body: requestInit.body, headers: requestInit.headers, url });

        return { ok: init.ok ?? true, status: init.status ?? 200 };
    };

    return { calls, fetch };
};

/** Find an attribute value by key. */
const attrValue = (attributes: OtlpKeyValue[], key: string): OtlpValue | undefined => attributes.find((attribute) => attribute.key === key)?.value;

/** Decode a POSTed OTLP trace-export body into its single span. */
const spanFrom = (body: string): { resourceAttributes: OtlpKeyValue[]; scopeName: string; span: ParsedSpan } => {
    const parsed = JSON.parse(body) as {
        resourceSpans: { resource: { attributes: OtlpKeyValue[] }; scopeSpans: { scope: { name: string }; spans: ParsedSpan[] }[] }[];
    };
    const resourceSpan = parsed.resourceSpans[0]!;
    const scopeSpan = resourceSpan.scopeSpans[0]!;

    return { resourceAttributes: resourceSpan.resource.attributes, scopeName: scopeSpan.scope.name, span: scopeSpan.spans[0]! };
};

/** Decode a POSTed OTLP log-export body into its records (a body may carry a whole batch). */
const logsFrom = (body: string): { records: ParsedLogRecord[]; resourceAttributes: OtlpKeyValue[]; scopeName: string } => {
    const parsed = JSON.parse(body) as {
        resourceLogs: { resource: { attributes: OtlpKeyValue[] }; scopeLogs: { logRecords: ParsedLogRecord[]; scope: { name: string } }[] }[];
    };
    const resourceLog = parsed.resourceLogs[0]!;
    const scopeLog = resourceLog.scopeLogs[0]!;

    return { records: scopeLog.logRecords, resourceAttributes: resourceLog.resource.attributes, scopeName: scopeLog.scope.name };
};

/** Decode a POSTed OTLP log-export body into its FIRST record. */
const logFrom = (body: string): { record: ParsedLogRecord; resourceAttributes: OtlpKeyValue[]; scopeName: string } => {
    const { records, resourceAttributes, scopeName } = logsFrom(body);

    return { record: records[0]!, resourceAttributes, scopeName };
};

describe(createContainerTelemetry, () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("is disabled and no-ops when no endpoint resolves", async () => {
        expect.assertions(3);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ fetch });

        expect(telemetry.enabled).toBe(false);

        telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        telemetry.emitLog({ message: "hi" });
        await telemetry.flush();

        expect(calls).toHaveLength(0);
        // `trace` still runs its work even when disabled.
        await expect(telemetry.trace("op", async () => 42)).resolves.toBe(42);
    });

    it("resolves the endpoint from LUNORA_OTLP_ENDPOINT", async () => {
        expect.assertions(2);

        vi.stubEnv("LUNORA_OTLP_ENDPOINT", "https://collect.example.com");
        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ fetch });

        expect(telemetry.enabled).toBe(true);

        telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        await telemetry.flush();

        expect(calls[0]!.url).toBe("https://collect.example.com/v1/traces");
    });

    it("posts a well-formed span for a successful operation", async () => {
        expect.assertions(9);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        telemetry.emitSpan({ attributes: { jobId: "j1" }, endMs: 10, name: "transcode", startMs: 5 });
        await telemetry.flush();

        expect(calls[0]!.url).toBe("https://collect.example.com/v1/traces");

        const { resourceAttributes, scopeName, span } = spanFrom(calls[0]!.body);

        expect(span.name).toBe("transcode");
        // SPAN_KIND_INTERNAL / STATUS_CODE_OK.
        expect(span.kind).toBe(1);
        expect(span.status.code).toBe(1);
        expect(span.traceId).toMatch(TRACE_ID_HEX);
        expect(span.spanId).toMatch(SPAN_ID_HEX);
        expect(attrValue(span.attributes, "jobId")?.stringValue).toBe("j1");
        expect(attrValue(resourceAttributes, "service.name")?.stringValue).toBe("lunora-container");
        expect(scopeName).toBe("@lunora/container");
    });

    it("stitches spans under a parent traceparent", async () => {
        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({
            endpoint: "https://collect.example.com",
            fetch,
            traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        });

        telemetry.emitSpan({ endMs: 10, name: "transcode", startMs: 5 });
        await telemetry.flush();

        const { span } = spanFrom(calls[0]!.body);

        // Inherits the Worker's trace id and hangs off its span id...
        expect(span.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
        expect(span.parentSpanId).toBe("b7ad6b7169203331");
        // ...but keeps its own child span id.
        expect(span.spanId).toMatch(SPAN_ID_HEX);
        expect(span.spanId).not.toBe("b7ad6b7169203331");
    });

    it("obeys a sampled-OUT traceparent: no span export, logs still flow", async () => {
        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({
            endpoint: "https://collect.example.com",
            fetch,
            // Flags `00` — the worker settled this trace as dropped and propagated
            // the verdict. Exporting anyway leaves the collector holding container
            // spans for a trace whose worker and shard spans were thrown away.
            traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00",
        });

        telemetry.emitSpan({ endMs: 10, name: "transcode", startMs: 5 });
        telemetry.emitLog({ message: "hello" });
        await telemetry.flush();

        expect(calls.map((call) => call.url)).toStrictEqual(["https://collect.example.com/v1/logs"]);

        // Logs are never sampled — but they carry the verdict so a collector can see it.
        const { records } = logsFrom(calls[0]!.body);

        expect(records[0]?.flags).toBe(0);
    });

    it("stamps every log record with the propagated trace context", async () => {
        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({
            endpoint: "https://collect.example.com",
            fetch,
            traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        });

        telemetry.emitLog({ message: "hello" });
        await telemetry.flush();

        const { records } = logsFrom(calls[0]!.body);

        // Without these a container log record is unreachable from the trace it
        // belongs to, so "show me this request's container logs" cannot be asked.
        expect(records[0]?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
        expect(records[0]?.spanId).toBe("b7ad6b7169203331");
        expect(records[0]?.flags).toBe(1);
    });

    it("carries the sampled bit in the exported span flags", async () => {
        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({
            endpoint: "https://collect.example.com",
            fetch,
            traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        });

        telemetry.emitSpan({ endMs: 10, name: "transcode", startMs: 5 });
        await telemetry.flush();

        expect(spanFrom(calls[0]!.body).span.flags).toBe(1);
    });

    it("mints a fresh root trace when the traceparent is malformed", async () => {
        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch, traceparent: "not-a-traceparent" });

        telemetry.emitSpan({ endMs: 10, name: "x", startMs: 5 });
        await telemetry.flush();

        const { span } = spanFrom(calls[0]!.body);

        expect(span.traceId).toMatch(TRACE_ID_HEX);
        expect(span.parentSpanId).toBeUndefined();
    });

    it("stitches under a future-version traceparent that carries trailing fields", async () => {
        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({
            endpoint: "https://collect.example.com",
            fetch,
            // Version `cc` (future) with an extra field appended — the spec says to
            // parse the first four fields and ignore the rest, not drop the header.
            traceparent: "cc-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra",
        });

        telemetry.emitSpan({ endMs: 10, name: "transcode", startMs: 5 });
        await telemetry.flush();

        const { span } = spanFrom(calls[0]!.body);

        expect(span.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
        expect(span.parentSpanId).toBe("b7ad6b7169203331");
    });

    it("mints a fresh root trace when the traceparent uses the reserved `ff` version", async () => {
        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({
            endpoint: "https://collect.example.com",
            fetch,
            traceparent: "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        });

        telemetry.emitSpan({ endMs: 10, name: "x", startMs: 5 });
        await telemetry.flush();

        const { span } = spanFrom(calls[0]!.body);

        expect(span.traceId).toMatch(TRACE_ID_HEX);
        expect(span.traceId).not.toBe("0af7651916cd43dd8448eb211c80319c");
        expect(span.parentSpanId).toBeUndefined();
    });

    it("marks an errored span with status ERROR, message, and error.type", async () => {
        expect.assertions(4);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        telemetry.emitSpan({ endMs: 10, error: { message: "boom", type: "RangeError" }, name: "op", startMs: 0 });
        await telemetry.flush();

        const { span } = spanFrom(calls[0]!.body);

        // STATUS_CODE_ERROR.
        expect(span.status.code).toBe(2);
        expect(span.status.message).toBe("boom");
        expect(attrValue(span.attributes, "error.type")?.stringValue).toBe("RangeError");
        expect(span.name).toBe("op");
    });

    it("encodes start/end as nanosecond strings with exact ms→ns precision", async () => {
        expect.assertions(3);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        telemetry.emitSpan({ endMs: 1005, name: "op", startMs: 1000 });
        await telemetry.flush();

        const { span } = spanFrom(calls[0]!.body);

        expect(span.startTimeUnixNano).toMatch(UNIX_NANO);
        expect(span.endTimeUnixNano).toMatch(UNIX_NANO);
        expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBe(BigInt(5 * 1_000_000));
    });

    it("encodes attribute value kinds by JS type", async () => {
        expect.assertions(4);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        telemetry.emitSpan({ attributes: { count: 3, ok: true, ratio: 1.5, tag: "x" }, endMs: 10, name: "op", startMs: 0 });
        await telemetry.flush();

        const { span } = spanFrom(calls[0]!.body);

        expect(attrValue(span.attributes, "count")?.intValue).toBe("3");
        expect(attrValue(span.attributes, "ratio")?.doubleValue).toBe(1.5);
        expect(attrValue(span.attributes, "ok")?.boolValue).toBe(true);
        expect(attrValue(span.attributes, "tag")?.stringValue).toBe("x");
    });

    it("posts a well-formed log record with mapped severity", async () => {
        expect.assertions(6);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        telemetry.emitLog({ attributes: { jobId: "j1" }, level: "warn", message: "slow", ts: 1700 });
        await telemetry.flush();

        expect(calls[0]!.url).toBe("https://collect.example.com/v1/logs");

        const { record, scopeName } = logFrom(calls[0]!.body);

        expect(record.body.stringValue).toBe("slow");
        expect(record.severityNumber).toBe(13);
        expect(record.severityText).toBe("WARN");
        expect(attrValue(record.attributes, "jobId")?.stringValue).toBe("j1");
        expect(scopeName).toBe("@lunora/container");
    });

    it("maps each log level to its OTLP severity number and defaults to info", async () => {
        expect.assertions(2);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        telemetry.emitLog({ level: "debug", message: "d" });
        telemetry.emitLog({ level: "error", message: "e" });
        telemetry.emitLog({ level: "info", message: "i" });
        telemetry.emitLog({ message: "default" });
        telemetry.emitLog({ level: "warn", message: "w" });
        await telemetry.flush();

        // One POST carrying all five records — the batcher coalesces them.
        expect(calls).toHaveLength(1);
        expect(logsFrom(calls[0]!.body).records.map((record) => record.severityNumber)).toStrictEqual([5, 17, 9, 9, 13]);
    });

    it("tolerates a trailing slash on the endpoint", async () => {
        expect.assertions(2);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com///", fetch });

        telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        telemetry.emitLog({ message: "hi" });
        await telemetry.flush();

        expect(calls[0]!.url).toBe("https://collect.example.com/v1/traces");
        expect(calls[1]!.url).toBe("https://collect.example.com/v1/logs");
    });

    it("sends a bearer token and merges headers case-insensitively", async () => {
        expect.assertions(3);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({
            endpoint: "https://collect.example.com",
            fetch,
            headers: { "Content-Type": "application/json; charset=utf-8", "x-lunora-deployment": "dep-1" },
            token: "svc-token",
        });

        telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        await telemetry.flush();

        expect(calls[0]!.headers.authorization).toBe("Bearer svc-token");
        expect(calls[0]!.headers["x-lunora-deployment"]).toBe("dep-1");
        // A cased `Content-Type` override replaces the default rather than duplicating it.
        expect(calls[0]!.headers["content-type"]).toBe("application/json; charset=utf-8");
    });

    it("honors a custom serviceName on spans and logs", async () => {
        expect.assertions(2);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch, serviceName: "transcoder" });

        telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        telemetry.emitLog({ message: "hi" });
        await telemetry.flush();

        expect(attrValue(spanFrom(calls[0]!.body).resourceAttributes, "service.name")?.stringValue).toBe("transcoder");
        expect(attrValue(logFrom(calls[1]!.body).resourceAttributes, "service.name")?.stringValue).toBe("transcoder");
    });

    it("auto-detects container resource attributes when detectResources is true", async () => {
        expect.assertions(5);

        vi.stubEnv("HOSTNAME", "pod-123");
        vi.stubEnv("SERVICE_VERSION", "v2.0.0");
        vi.stubEnv("ENVIRONMENT", "production");
        vi.stubEnv("KUBERNETES_SERVICE_HOST", "kubernetes.default.svc");
        vi.stubEnv("KUBERNETES_POD_NAME", "my-pod-abc");

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ detectResources: true, endpoint: "https://collect.example.com", fetch, serviceName: "transcoder" });

        telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        await telemetry.flush();

        const { resourceAttributes } = spanFrom(calls[0]!.body);

        expect(attrValue(resourceAttributes, "service.name")?.stringValue).toBe("transcoder");
        expect(attrValue(resourceAttributes, "service.version")?.stringValue).toBe("v2.0.0");
        expect(attrValue(resourceAttributes, "deployment.environment")?.stringValue).toBe("production");
        expect(attrValue(resourceAttributes, "host.name")?.stringValue).toBe("pod-123");
        expect(attrValue(resourceAttributes, "k8s.pod.name")?.stringValue).toBe("my-pod-abc");
    });

    it("times a successful trace() and returns its value", async () => {
        expect.assertions(4);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        const result = await telemetry.trace("op", async () => 42, { k: "v" });

        await telemetry.flush();

        expect(result).toBe(42);

        const { span } = spanFrom(calls[0]!.body);

        expect(span.name).toBe("op");
        expect(span.status.code).toBe(1);
        expect(attrValue(span.attributes, "k")?.stringValue).toBe("v");
    });

    it("records an errored span and rethrows when trace()'s work throws", async () => {
        expect.assertions(4);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        await expect(
            telemetry.trace("op", async () => {
                throw new TypeError("boom");
            }),
        ).rejects.toThrow("boom");

        await telemetry.flush();

        const { span } = spanFrom(calls[0]!.body);

        expect(span.status.code).toBe(2);
        expect(span.status.message).toBe("boom");
        expect(attrValue(span.attributes, "error.type")?.stringValue).toBe("TypeError");
    });

    it("reports a rejected send to onError without throwing", async () => {
        expect.assertions(2);

        const onError = vi.fn<(error: unknown) => void>();
        const failing: OtelFetchLike = async () => {
            throw new Error("network down");
        };
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch: failing, onError });

        expect(() => {
            telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        }).not.toThrow();

        await telemetry.flush();

        expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it("reports a missing fetch to onError without throwing", async () => {
        expect.assertions(2);

        vi.stubGlobal("fetch", undefined);
        const onError = vi.fn<(error: unknown) => void>();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", onError });

        expect(() => {
            telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        }).not.toThrow();

        // Emitting only buffers; the missing-`fetch` error surfaces when the
        // batch drains, which is what `flush()` forces.
        await telemetry.flush();

        expect(onError).toHaveBeenCalledWith(expect.any(TypeError));
    });

    it("cancels the response body so the socket can be released", async () => {
        expect.assertions(2);

        const cancel = vi.fn<() => Promise<void>>().mockResolvedValue();
        const fetch: OtelFetchLike = async () => {
            return { body: { cancel }, ok: true, status: 200 };
        };
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        telemetry.emitLog({ message: "hi" });
        await telemetry.flush();

        expect(cancel).toHaveBeenCalledTimes(2);
        // A response without a body (e.g. 204) must not throw.
        expect(cancel).toHaveBeenCalledWith();
    });

    it("passes an abort signal on every POST", async () => {
        expect.assertions(1);

        let signal: AbortSignal | undefined;
        const fetch: OtelFetchLike = async (_url, init) => {
            signal = init.signal;

            return { ok: true, status: 200 };
        };
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        await telemetry.flush();

        expect(signal).toBeInstanceOf(AbortSignal);
    });

    it("aborts a hung POST after timeoutMs so flush can complete", async () => {
        expect.assertions(3);

        const onError = vi.fn<(error: unknown) => void>();
        let signal: AbortSignal | undefined;
        // Only settles when its abort signal fires — without the timeout, flush would hang forever.
        const hanging: OtelFetchLike = (_url, init) => {
            signal = init.signal;

            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => {
                    reject(new Error("aborted"));
                });
            });
        };
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch: hanging, onError, timeoutMs: 5 });

        telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        await telemetry.flush();

        expect(onError).toHaveBeenCalledTimes(1);
        // The bound came from the per-request timeout, not a manual abort.
        expect(signal?.aborted).toBe(true);
        expect((signal?.reason as Error).name).toBe("TimeoutError");
    });

    it("reports a non-2xx collector response to onError and still releases the socket", async () => {
        expect.assertions(2);

        const onError = vi.fn<(error: unknown) => void>();
        const cancel = vi.fn<() => Promise<void>>().mockResolvedValue();
        // A rejected export (bad token / wrong path / 5xx) resolves, but not ok.
        const rejecting: OtelFetchLike = async () => {
            return { body: { cancel }, ok: false, status: 401 };
        };
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch: rejecting, onError });

        telemetry.emitSpan({ endMs: 10, name: "op", startMs: 0 });
        await telemetry.flush();

        expect(onError).toHaveBeenCalledWith(expect.any(Error));
        // The socket is released for keep-alive reuse even on a rejected export.
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("batches many spans and logs into one POST per signal", async () => {
        expect.assertions(4);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        // The docblock's worked example: twenty spans and thirty log lines. One
        // POST per span/line would be fifty round-trips (and fifty subrequests
        // against the worker's budget on the sibling sink); batched it is two.
        for (let index = 0; index < 20; index += 1) {
            telemetry.emitSpan({ endMs: index + 1, name: `span-${String(index)}`, startMs: index });
        }

        for (let index = 0; index < 30; index += 1) {
            telemetry.emitLog({ message: `line-${String(index)}` });
        }

        await telemetry.flush();

        expect(calls).toHaveLength(2);

        const traces = calls.find((call) => call.url.endsWith("/v1/traces"))!;
        const logs = calls.find((call) => call.url.endsWith("/v1/logs"))!;
        const parsedSpans = (
            JSON.parse(traces.body) as {
                resourceSpans: { scopeSpans: { spans: ParsedSpan[] }[] }[];
            }
        ).resourceSpans[0]!.scopeSpans[0]!.spans;

        expect(parsedSpans).toHaveLength(20);
        // Buffer order is emit order, so the batch is not just the right size.
        expect(parsedSpans.map((span) => span.name)).toStrictEqual(Array.from({ length: 20 }, (_, index) => `span-${String(index)}`));
        expect(logsFrom(logs.body).records).toHaveLength(30);
    });

    it("encodes non-finite and unsafe-integer attributes as valid OTLP", async () => {
        expect.assertions(3);

        const { calls, fetch } = stubFetch();
        const telemetry = createContainerTelemetry({ endpoint: "https://collect.example.com", fetch });

        telemetry.emitSpan({ attributes: { big: 1e21, count: 3, ratio: Number.NaN }, endMs: 10, name: "op", startMs: 0 });
        await telemetry.flush();

        const { span } = spanFrom(calls[0]!.body);

        // NaN has no valid AnyValue → falls back to a string, not JSON `null`.
        expect(attrValue(span.attributes, "ratio")).toStrictEqual({ stringValue: "NaN" });
        // A value beyond 2^53 can't be a proto3 int64 decimal string → doubleValue.
        expect(attrValue(span.attributes, "big")).toStrictEqual({ doubleValue: 1e21 });
        // A safe integer stays an `intValue` decimal string.
        expect(attrValue(span.attributes, "count")).toStrictEqual({ intValue: "3" });
    });
});
