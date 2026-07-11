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
 * case-insensitive header merge, and the `resourceSpans`/`resourceLogs`
 * envelopes. Each package keeps only its own transport and event→OTLP mapping.
 *
 * Keep this genuinely zero-dependency (only built-ins) so inlining stays sound.
 */

/** OTLP `SeverityNumber` levels Lunora emits (the worker adds `log`; the container never uses it). */
type OtlpLevel = "debug" | "error" | "info" | "log" | "warn";

/**
 * OTLP log severity numbers (`SeverityNumber` in the spec) keyed by level. `log`
 * has no distinct OTLP level, so it maps to INFO like a plain `console.log`.
 */
const OTLP_SEVERITY: Record<OtlpLevel, number> = {
    debug: 5, // DEBUG
    error: 17, // ERROR
    info: 9, // INFO
    log: 9, // INFO
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
 * Encode wall-clock milliseconds as an OTLP `*UnixNano` string. proto3 JSON
 * represents uint64 as a decimal string, and ms→ns is ×10^6, so the six trailing
 * zeros are exact — no `BigInt`, no float rounding.
 */
const otlpUnixNano = (ms: number): string => `${String(Math.round(ms))}000000`;

/**
 * A random lowercase-hex id of `bytes` length. OTLP/JSON is explicit that
 * `trace_id`/`span_id` are hex strings (the one documented exception to proto3
 * JSON's base64 `bytes` encoding), so this is the correct on-wire form. Uses the
 * Web Crypto global (present in workerd, Node ≥ 19, Bun, Deno) — no Node built-in
 * import; the engines field guarantees Node ≥ 22.15, so it is always present.
 */
const otlpRandomHex = (bytes: number): string => {
    const buffer = new Uint8Array(bytes);

    crypto.getRandomValues(buffer);

    let hex = "";

    for (const byte of buffer) {
        hex += byte.toString(16).padStart(2, "0");
    }

    return hex;
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

/** Wrap one encoded OTLP span in the `ExportTraceServiceRequest` envelope. */
const wrapResourceSpans = (span: unknown, scopeName: string, serviceName: string): unknown => {
    return {
        resourceSpans: [
            {
                resource: { attributes: [encodeAttribute("service.name", serviceName)] },
                scopeSpans: [{ scope: { name: scopeName }, spans: [span] }],
            },
        ],
    };
};

/** Wrap one encoded OTLP log record in the `ExportLogsServiceRequest` envelope. */
const wrapResourceLogs = (logRecord: unknown, scopeName: string, serviceName: string): unknown => {
    return {
        resourceLogs: [
            {
                resource: { attributes: [encodeAttribute("service.name", serviceName)] },
                scopeLogs: [{ logRecords: [logRecord], scope: { name: scopeName } }],
            },
        ],
    };
};

export type { OtlpAnyValue, OtlpAttribute, OtlpAttributeValue, OtlpLevel };
export { encodeAttribute, encodeAttributes, mergeHeaders, OTLP_SEVERITY, otlpRandomHex, otlpUnixNano, wrapResourceLogs, wrapResourceSpans };
