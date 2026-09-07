/**
 * Shared OTLP-over-HTTP/JSON wire primitives, bundler-inlined (like
 * {@link file://./batch-wire.ts}) so the worker sink (`@lunora/runtime`) and the
 * container exporter (`@lunora/container`) build their OTLP bodies from ONE
 * encoder instead of two drifting mirrors. The two consumers sit on opposite
 * tiers (leaf server runtime vs. zero-Cloudflare container helper) and must not
 * gain a runtime dependency edge on each other, so this lives in `shared/` and is
 * inlined into each `dist` rather than published as a package.
 *
 * These are the pure, dependency-free pieces of the OTLP/JSON contract both sides
 * share: the `AnyValue`/`KeyValue` encoding, `SeverityNumber` map, the
 * decimal-string `*UnixNano` and hex `trace_id`/`span_id` encoders, the
 * case-insensitive header merge, and the `resourceSpans`/`resourceLogs`/
 * `resourceMetrics` envelopes. Each package keeps only its own transport and
 * event→OTLP mapping.
 *
 * Keep this genuinely zero-dependency (only built-ins) so inlining stays sound.
 */
import type { ContextLogLevel } from "./log-event";

/** OTLP `SeverityNumber` levels Lunora emits — the canonical `ctx.log` severity union. */
type OtlpLevel = ContextLogLevel;

/**
 * OTLP log severity numbers (`SeverityNumber` in the spec) keyed by level. `log`
 * has no distinct OTLP level, so it maps to INFO like a plain `console.log`.
 * `trace`/`fatal` extend the console tiers to the full OTel range so a collector
 * (and the Cloud log viewer) can render the same six-step severity ramp
 * (`trace`→`fatal`) other OpenTelemetry sources use.
 */
const OTLP_SEVERITY: Record<OtlpLevel, number> = {
    debug: 5, // DEBUG
    error: 17, // ERROR
    fatal: 21, // FATAL
    info: 9, // INFO
    log: 9, // INFO
    trace: 1, // TRACE
    warn: 13, // WARN
};

/** One OTLP `AnyValue` — the JSON encoding of a typed attribute value. */
type OtlpAnyValue = { boolValue: boolean } | { doubleValue: number } | { intValue: string } | { stringValue: string };

/** One OTLP `KeyValue` attribute. */
interface OtlpAttribute {
    key: string;
    value: OtlpAnyValue;
}

/** A JS attribute value the encoder maps onto an OTLP `AnyValue`. */
type OtlpAttributeValue = boolean | number | string;

/**
 * A `Resource.attributes` bag — the process-level identity (`service.name`,
 * `service.version`, `cloud.region`, …) attached to every exported signal.
 * Lives here rather than in either exporter because both packages build one and
 * `wrapResource*` consumes it.
 */
type OtlpResourceAttributes = Record<string, OtlpAttributeValue>;

/**
 * Encode wall-clock milliseconds as an OTLP `*UnixNano` string. proto3 JSON
 * represents uint64 as a decimal string, and ms→ns is ×10^6, so the six trailing
 * zeros are exact — no `BigInt`, no float rounding.
 */
const otlpUnixNano = (ms: number): string => `${String(Math.round(ms))}000000`;

/** Every byte value as its two-hex-digit string, so the id loop never formats. */
const HEX_BYTE: ReadonlyArray<string> = Array.from({ length: 256 }, (_value, index) => index.toString(16).padStart(2, "0"));

/**
 * Bytes drawn from `crypto.getRandomValues` per refill.
 *
 * The draw itself, not the hex formatting, is what an id costs: it dominated
 * `otlpRandomHex` and made minting one request's trace+span id ~9% of the whole
 * worker RPC dispatch path. 512 bytes serves 21 request-pairs (16+8) per call.
 * Small enough to stay a trivial allocation in a Workers isolate, large enough
 * that the draw stops showing up in a profile.
 */
const POOL_BYTES = 512;

const randomPool = new Uint8Array(POOL_BYTES);

/** Next unconsumed byte in {@link randomPool}; starts spent so the first id refills. */
let poolOffset = POOL_BYTES;

/** `bytes` bytes of `buffer` from `start`, as lowercase hex. */
const hexSlice = (buffer: Uint8Array, start: number, bytes: number): string => {
    let hex = "";

    for (let index = 0; index < bytes; index += 1) {
        hex += HEX_BYTE[buffer[start + index] as number];
    }

    return hex;
};

/**
 * A random lowercase-hex id of `bytes` length. OTLP/JSON is explicit that
 * `trace_id`/`span_id` are hex strings (the one documented exception to proto3
 * JSON's base64 `bytes` encoding), so this is the correct on-wire form. Uses the
 * Web Crypto global (present in workerd, Node ≥ 19, Bun, Deno) — no Node built-in
 * import; the engines field guarantees Node ≥ 22.15, so it is always present.
 *
 * Ids come out of a buffer refilled from `crypto.getRandomValues` rather than a
 * per-call draw. This is the SAME CSPRNG byte stream — every byte is handed out
 * exactly once and the offset only advances — so the distribution is unchanged,
 * which matters beyond aesthetics: `resolveTraceSampling` derives the head
 * sampling verdict from one of these ids (the freshly-minted SPAN id when the
 * inbound `traceparent` is untrusted, the TRACE id when it is trusted — see
 * `otel-trace.ts`'s `beginDispatchTrace`), so a biased id would bias what gets
 * traced.
 * The pool is filled lazily (never at module scope) so importing this file does
 * no work, and it is per-isolate like every other module-level value here.
 */
const otlpRandomHex = (bytes: number): string => {
    // An id larger than the pool can never be served from it — refilling would
    // still leave the read running off the end and splice "undefined" into the
    // hex. No caller asks for more than 16, but that failure would be silent and
    // on the wire, so draw an oversized id directly instead of trusting callers.
    if (bytes > POOL_BYTES) {
        const buffer = new Uint8Array(bytes);

        crypto.getRandomValues(buffer);

        return hexSlice(buffer, 0, bytes);
    }

    if (poolOffset + bytes > POOL_BYTES) {
        crypto.getRandomValues(randomPool);
        poolOffset = 0;
    }

    const hex = hexSlice(randomPool, poolOffset, bytes);

    poolOffset += bytes;

    return hex;
};

/** Lowercase-hex validator for `traceparent` id fields. */
const HEX_ONLY = /^[0-9a-f]+$/;

/**
 * Build a W3C `traceparent` header from a 32-hex trace id + 16-hex span id:
 * `00-<trace-id>-<span-id>-<flags>` (version 0). The `sampled` flag (bit 0 of the
 * trace-flags octet) is `01` when the trace was sampled in and `00` when it was
 * sampled out — how the runtime propagates its head-sampling decision to the
 * shard and any container beneath it, so the whole trace is kept or dropped
 * coherently. Defaults to sampled for callers that don't sample. The ids are the
 * same lowercase-hex form {@link otlpRandomHex} produces, so a worker's
 * trace/span id composes into a `traceparent` with no reformatting.
 */
const buildTraceparent = (traceId: string, spanId: string, sampled = true): string => `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;

/**
 * Parse a W3C `traceparent` into `{ traceId, parentSpanId }`, or `undefined` when
 * malformed. Validates the `version-traceId-spanId-flags` shape (2-hex version,
 * 32-hex trace id, 16-hex span id, 2-hex flags) and rejects the all-zero ids the
 * spec forbids. Only the two ids are returned — the version/flags are validated
 * but not surfaced.
 *
 * Forward-compatible per the spec: version `00` is strict (exactly four fields),
 * but a future version may append fields, so a `>= 4`-field header on a higher
 * version parses off its first four and ignores the rest rather than being
 * dropped. The reserved version `ff` is rejected.
 *
 * `sampled` is bit 0 of the trace-flags octet — the head-sampling decision the
 * upstream (the Lunora worker) propagated; consumers use it to keep or drop the
 * whole trace coherently.
 */
const parseTraceparent = (header: null | string | undefined): { parentSpanId: string; sampled: boolean; traceId: string } | undefined => {
    if (header === null || header === undefined) {
        return undefined;
    }

    const parts = header.trim().toLowerCase().split("-");
    const [version, traceId, parentSpanId, flags] = parts;

    if (
        parts.length < 4 ||
        version === undefined ||
        version.length !== 2 ||
        !HEX_ONLY.test(version) ||
        version === "ff" ||
        // Version 00 forbids trailing fields; only a future version may carry them.
        (version === "00" && parts.length !== 4) ||
        traceId === undefined ||
        parentSpanId === undefined ||
        flags === undefined ||
        flags.length !== 2 ||
        !HEX_ONLY.test(flags) ||
        traceId.length !== 32 ||
        parentSpanId.length !== 16 ||
        !HEX_ONLY.test(traceId) ||
        !HEX_ONLY.test(parentSpanId) ||
        traceId === "00000000000000000000000000000000" ||
        parentSpanId === "0000000000000000"
    ) {
        return undefined;
    }

    // Bit 0 of the trace-flags octet is the W3C `sampled` flag.
    return { parentSpanId, sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01, traceId };
};

/** Encode one attribute, choosing the OTLP value kind from the JS type. */
const encodeAttribute = (key: string, value: OtlpAttributeValue): OtlpAttribute => {
    if (typeof value === "boolean") {
        return { key, value: { boolValue: value } };
    }

    if (typeof value === "number") {
        // Non-finite (NaN/±Infinity) has no valid `AnyValue` encoding — `JSON.stringify`
        // would emit `null`, which a strict collector rejects — so fall back to a
        // string. Safe integers use `intValue` (a decimal string, per proto3 JSON);
        // everything else uses `doubleValue`, which also keeps values beyond 2^53 out
        // of the int64 decimal path (where `String(1e21)` would yield "1e+21").
        if (!Number.isFinite(value)) {
            return { key, value: { stringValue: String(value) } };
        }

        return Number.isSafeInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
    }

    return { key, value: { stringValue: value } };
};

/** Encode an attribute bag into the OTLP `KeyValue` list. */
const encodeAttributes = (attributes: Record<string, OtlpAttributeValue> | undefined): OtlpAttribute[] => {
    if (attributes === undefined) {
        return [];
    }

    return Object.entries(attributes).map(([key, value]) => encodeAttribute(key, value));
};

/**
 * Case-insensitively merge headers: `defaults` first, then `overrides` (which
 * win). HTTP header names are case-insensitive, so a naive spread of
 * `{ "content-type": ..., ...overrides }` would keep BOTH `content-type` and a
 * caller's `Content-Type` as distinct keys and `fetch`/`Headers` would then
 * *combine* them ("application/json, text/plain") rather than let the caller
 * override; normalising the key first guarantees one caller-controlled value per
 * header. A non-empty `token` is applied last as `authorization: Bearer <token>`
 * so it wins over any caller-supplied authorization.
 */
const mergeHeaders = (defaults: Record<string, string>, overrides: Record<string, string> | undefined, token?: string): Record<string, string> => {
    const merged: Record<string, string> = {};
    const seen = new Map<string, string>();

    const put = (name: string, value: string): void => {
        const lower = name.toLowerCase();
        const existing = seen.get(lower);

        if (existing === undefined) {
            seen.set(lower, name);
            merged[name] = value;
        } else {
            // Replace the existing key's value in place so the override wins
            // without introducing a second, differently-cased duplicate.
            merged[existing] = value;
        }
    };

    for (const [name, value] of Object.entries(defaults)) {
        put(name, value);
    }

    for (const [name, value] of Object.entries(overrides ?? {})) {
        put(name, value);
    }

    if (token !== undefined && token.length > 0) {
        put("authorization", `Bearer ${token}`);
    }

    return merged;
};

/**
 * Normalize "one item or many" into an array. The wrappers below all accept
 * either so a batching exporter and a single-shot one share one encoder: an
 * `ExportXServiceRequest` carrying N items in one `scope*` list is the same
 * envelope as one carrying a single item, and every collector accepts both.
 */
const toArray = (value: unknown[] | unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/**
 * The OTel `SpanKind` union, in the spec's own words rather than its wire
 * numbers, so a call site reads `{ kind: "client" }` instead of `{ kind: 3 }`.
 *
 * Kind is not cosmetic: a service map is built from it. A CLIENT span with no
 * matching SERVER span on the other side is a dropped hop; PRODUCER/CONSUMER is
 * what makes a queue render as an async edge rather than a synchronous call.
 * Getting it wrong is why "everything is INTERNAL" traces produce no topology.
 */
type OtlpSpanKind = "client" | "consumer" | "internal" | "producer" | "server";

/** `SpanKind` wire numbers, keyed by the readable union above. */
const OTLP_SPAN_KIND: Record<OtlpSpanKind, number> = {
    client: 3,
    consumer: 5,
    internal: 1,
    producer: 4,
    server: 2,
};

/**
 * Reserved Lunora attribute keys, defined once so the DO (`@lunora/do`) and
 * worker (`@lunora/runtime`) exporters cannot drift apart — a collector query on
 * one of these keys must match EVERY source that emits it. Before this record,
 * the two exporters re-typed the same keys as string literals and had already
 * diverged (`lunora.error.type` on one side, `error.type` on the other).
 *
 * The dispatch dimensions with no OTel equivalent — `functionPath`, `ok`,
 * `shardKey`, `userId`, `durationMs` — stay under the `lunora.*` namespace. The
 * error pair converges on OTel semantic-convention keys instead: `error.type`
 * (stable) and `error.message` — both are span-*level* attributes, so the
 * `exception.*` keys stay reserved for the exception span-*event* the runtime
 * emits separately.
 *
 * Every emit path MUST reference these constants; a literal `"lunora.…"`
 * attribute string in an emitter is a drift bug.
 */
const LUNORA_ATTR: Readonly<{
    durationMs: "lunora.duration_ms";
    errorMessage: "error.message";
    errorType: "error.type";
    functionPath: "lunora.function_path";
    ok: "lunora.ok";
    shardKey: "lunora.shard_key";
    userId: "lunora.user_id";
}> = Object.freeze({
    durationMs: "lunora.duration_ms",
    errorMessage: "error.message",
    errorType: "error.type",
    functionPath: "lunora.function_path",
    ok: "lunora.ok",
    shardKey: "lunora.shard_key",
    userId: "lunora.user_id",
} as const);

/**
 * Build the OTLP `Resource.attributes` list for a signal envelope. `service.name`
 * is the default and `extra` is merged over it, so a caller-supplied
 * `service.name` in `extra` wins. Kept as a separate helper so `wrapResource*`
 * callers don't duplicate the merge logic.
 */
const buildResourceAttributes = (serviceName: string, extra?: Record<string, OtlpAttributeValue>): OtlpAttribute[] => {
    const merged: Record<string, OtlpAttributeValue> = { "service.name": serviceName };

    for (const [key, value] of Object.entries(extra ?? {})) {
        merged[key] = value;
    }

    return Object.entries(merged).map(([key, value]) => encodeAttribute(key, value));
};

/** Wrap one encoded OTLP span in the `ExportTraceServiceRequest` envelope. */
const wrapResourceSpans = (
    spans: unknown[] | unknown,
    scopeName: string,
    serviceName: string,
    resourceAttributes?: Record<string, OtlpAttributeValue>,
): unknown => {
    return {
        resourceSpans: [
            {
                resource: { attributes: buildResourceAttributes(serviceName, resourceAttributes) },
                scopeSpans: [{ scope: { name: scopeName }, spans: toArray(spans) }],
            },
        ],
    };
};

/** Wrap one encoded OTLP log record in the `ExportLogsServiceRequest` envelope. */
const wrapResourceLogs = (
    logRecords: unknown[] | unknown,
    scopeName: string,
    serviceName: string,
    resourceAttributes?: Record<string, OtlpAttributeValue>,
): unknown => {
    return {
        resourceLogs: [
            {
                resource: { attributes: buildResourceAttributes(serviceName, resourceAttributes) },
                scopeLogs: [{ logRecords: toArray(logRecords), scope: { name: scopeName } }],
            },
        ],
    };
};

/** Wrap one encoded OTLP metric in the `ExportMetricsServiceRequest` envelope. */
const wrapResourceMetrics = (
    metrics: unknown[] | unknown,
    scopeName: string,
    serviceName: string,
    resourceAttributes?: Record<string, OtlpAttributeValue>,
): unknown => {
    return {
        resourceMetrics: [
            {
                resource: { attributes: buildResourceAttributes(serviceName, resourceAttributes) },
                scopeMetrics: [{ metrics: toArray(metrics), scope: { name: scopeName } }],
            },
        ],
    };
};

export type { OtlpAnyValue, OtlpAttribute, OtlpAttributeValue, OtlpLevel, OtlpResourceAttributes, OtlpSpanKind };
export {
    buildTraceparent,
    LUNORA_ATTR,
    OTLP_SPAN_KIND,
    encodeAttribute,
    encodeAttributes,
    mergeHeaders,
    OTLP_SEVERITY,
    otlpRandomHex,
    otlpUnixNano,
    parseTraceparent,
    wrapResourceLogs,
    wrapResourceMetrics,
    wrapResourceSpans,
};
