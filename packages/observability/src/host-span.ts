/**
 * The bridge onto a host runtime's own tracer: the structural shapes of a
 * host-native span and `tracing` namespace (Cloudflare's `cloudflare:workers`
 * `tracing` is one that satisfies them) and the best-effort attribute copying
 * onto such a span. Split from `context-telemetry.ts` so the `ctx.trace` /
 * `ctx.metrics` machinery there stays about Lunora's own spans.
 */
import type { LogFields } from "../../../shared/log-fields";
import { LUNORA_ATTR } from "../../../shared/otlp";
import type { SpanEvent } from "../../../shared/span-event";

/**
 * Minimal structural shape of one **host-native custom span** — the object a
 * `tracing.enterSpan(name, (span) => …)` callback receives (GA 2026-06-16). Only
 * the surface the bridge touches is declared, so `@lunora/do` needs no runtime
 * dependency on `cloudflare:workers`; the real platform span is structurally
 * assignable.
 */

/**
 * A host-supplied span, structurally.
 *
 * Named for the role rather than the provider: this is whatever the runtime's
 * own tracer hands back, and Cloudflare's `enterSpan` callback argument is one
 * shape that satisfies it. Kept structural so no provider type is imported —
 * the repo's documented `*Like` pattern.
 */
interface HostSpanLike {
    /**
     * Whether this span is actually being recorded by the runtime's sampler.
     * `false` off the traced path (unsampled) — the bridge skips its
     * `setAttribute` work in that case rather than building attribute strings for
     * a span nobody will read.
     */
    readonly isTraced: boolean;

    /**
     * Record an OTel `exception` event on the span (CF 2026-09-25). Optional and
     * feature-detected: older runtimes only have `setAttribute`.
     */
    recordException?: (exception: { message: string; name: string }) => unknown;
    /** Attach one primitive attribute to the CF span. */
    setAttribute: (key: string, value: boolean | number | string | undefined) => unknown;
    /** Attach several attributes in one call (CF 2026-09-25). Optional, like `recordException`. */
    setAttributes?: (attributes: Record<string, boolean | number | string>) => unknown;
}

/**
 * Minimal structural shape of the `tracing` namespace exported by
 * `cloudflare:workers`. `enterSpan` opens a custom span that auto-nests under the
 * runtime's ambient span and ends when `callback` settles.
 */
interface HostTracingLike {
    enterSpan: <T>(name: string, callback: (span: HostSpanLike) => T) => T;

    /**
     * The currently active span; outside any custom span, the invocation's root
     * span (CF 2026-09-25). Optional and feature-detected: absent on older runtimes.
     */
    getActiveSpan?: () => HostSpanLike | undefined;
}

/**
 * Resolves CF's `tracing` namespace, or `undefined` when it is unavailable —
 * on a host with no native tracer, on a Cloudflare compat date predating custom spans, or when
 * `tracing.enterSpan` is not a function. **Injected, never imported here**, so the
 * tracer stays pure and unit-testable without `cloudflare:workers`; the shard
 * supplies the real resolver, tests a fake or `undefined`.
 */
type HostTracingResolver = () => HostTracingLike | Promise<HostTracingLike | undefined> | undefined;

/**
 * Copy an attribute bag onto a host span, best-effort: one native
 * `setAttributes` call where the runtime has it, a `setAttribute` loop where it
 * does not. Skipped for an untraced span; non-primitive values are dropped,
 * since CF's setters take `string | number | boolean` only.
 */
const setHostSpanAttributes = (span: HostSpanLike, attributes: Record<string, LogFields[string]>): void => {
    if (!span.isTraced) {
        return;
    }

    const primitives: Record<string, boolean | number | string> = {};

    for (const [key, value] of Object.entries(attributes)) {
        if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
            primitives[key] = value;
        }
    }

    if (typeof span.setAttributes === "function") {
        span.setAttributes(primitives);

        return;
    }

    for (const [key, value] of Object.entries(primitives)) {
        span.setAttribute(key, value);
    }
};

/**
 * Mirror a finished span's name-independent key attributes onto its Cloudflare
 * custom span, best-effort. Pure and side-effect-only, so the wrapping in
 * `createTracer` stays readable and this is directly unit-testable with a
 * fake span.
 *
 * Gated on `span.isTraced`: an untraced span discards attributes, so building the
 * strings would be waste. User attributes are already coerced to JSON primitives
 * by `normalizeLogFields` (a nested value arrives as its JSON string), so every
 * one is copyable; the `typeof` guard is a defensive net against a non-primitive
 * ever reaching CF's `setAttribute`, which takes `string | number | boolean |
 * undefined`.
 */
const applyHostSpanAttributes = (
    span: HostSpanLike,
    meta: {
        attributes: Record<string, LogFields[string]>;
        durationMs: number;
        error: SpanEvent["error"];
        functionPath: string;
        ok: boolean;
        shardKey: string | undefined;
        userId: string | undefined;
    },
): void => {
    if (!span.isTraced) {
        return;
    }

    const attributes: Record<string, LogFields[string]> = {
        [LUNORA_ATTR.functionPath]: meta.functionPath,
        [LUNORA_ATTR.ok]: meta.ok,
        [LUNORA_ATTR.durationMs]: meta.durationMs,
        ...(meta.shardKey === undefined ? {} : { [LUNORA_ATTR.shardKey]: meta.shardKey }),
        ...(meta.userId === undefined ? {} : { [LUNORA_ATTR.userId]: meta.userId }),
        // Wire change: these were `lunora.error.type` / `lunora.error.message`;
        // they now converge on the OTel-standard `error.type` / `error.message`
        // so a collector query matches the worker exporter's span too.
        ...(meta.error === undefined ? {} : { [LUNORA_ATTR.errorType]: meta.error.type, [LUNORA_ATTR.errorMessage]: meta.error.message }),
    };

    for (const [key, value] of Object.entries(meta.attributes)) {
        attributes[`lunora.attr.${key}`] = value;
    }

    setHostSpanAttributes(span, attributes);

    // The already-redacted `{ name, message }`, never the raw thrown value: CF
    // exports this span too, so it keeps the same `captureRaw` posture as ours.
    if (meta.error !== undefined && typeof span.recordException === "function") {
        span.recordException({ message: meta.error.message, name: meta.error.type });
    }
};

export type { HostSpanLike, HostTracingLike, HostTracingResolver };
export { applyHostSpanAttributes, setHostSpanAttributes };
