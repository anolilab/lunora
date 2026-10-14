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

    /**
     * Set the span's OTel status (workers-types 5.20260929). Optional and
     * feature-detected, like `recordException`: older runtimes lack it. The
     * bridge only ever sets `"error"` — OTel instrumentation leaves a successful
     * span `"unset"` rather than marking it `"ok"`.
     */
    setStatus?: (status: { code: "error" | "ok" | "unset"; message?: string }) => unknown;
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
 * Mark a host span as failed: OTel status `"error"` with the given message, so
 * Cloudflare's trace UI (and any OTel backend fed from it) shows the span as
 * failed rather than only carrying an `exception` event. Skipped for an untraced
 * span and on a runtime without `setStatus`.
 *
 * Guarded on its own so a throwing `setStatus` never escapes, and every caller
 * runs it BEFORE the attribute writes so a throwing `setAttributes` /
 * `recordException` cannot drop it. `message` must already be redacted — the
 * host exports this span too, so it keeps Lunora's `captureRaw` posture.
 */
const setHostSpanErrorStatus = (span: HostSpanLike, message: string): void => {
    if (!span.isTraced || typeof span.setStatus !== "function") {
        return;
    }

    try {
        span.setStatus({ code: "error", message });
    } catch {
        // Best-effort — the status is additive telemetry.
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

    if (meta.error !== undefined) {
        // Status first: an `exception` event alone does not make a backend render
        // the span as failed. Success stays `"unset"`, the OTel posture.
        setHostSpanErrorStatus(span, meta.error.message);
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

/**
 * Mirror a finished dispatch onto the host's invocation span — the one
 * `tracing.getActiveSpan()` returns once every `ctx.trace` custom span has
 * ended. Pure and fully best-effort: a missing `getActiveSpan`, an untraced span
 * or a throwing setter is a silent no-op, never an error for the dispatch.
 *
 * `attributes` is the dispatch root span's already-redacted wide event, when it
 * recorded one. `error` is set when the dispatch failed; its `serverFault` is the
 * CALLER's verdict on whether that failure is the server's: the status of the
 * response it actually sent (>= 500) for an RPC, always `true` for a trigger
 * that threw. Only a server fault marks the span failed; a 4xx is an expected
 * client outcome that OTel's server-span convention leaves `"unset"`. `message`
 * must already be redacted.
 *
 * The status is written before the attributes so a throwing attribute setter
 * cannot drop it.
 */
const applyHostRootSpan = (
    tracing: HostTracingLike | undefined,
    root: {
        attributes?: Record<string, LogFields[string]>;
        error?: { message: string; serverFault: boolean };
    },
): void => {
    let span: HostSpanLike | undefined;

    try {
        span = tracing?.getActiveSpan?.();
    } catch {
        return;
    }

    if (span === undefined) {
        return;
    }

    if (root.error?.serverFault === true) {
        setHostSpanErrorStatus(span, root.error.message);
    }

    if (root.attributes !== undefined) {
        try {
            setHostSpanAttributes(span, root.attributes);
        } catch {
            // Best-effort — the mirror is additive telemetry.
        }
    }
};

export type { HostSpanLike, HostTracingLike, HostTracingResolver };
export { applyHostRootSpan, applyHostSpanAttributes, setHostSpanAttributes };
