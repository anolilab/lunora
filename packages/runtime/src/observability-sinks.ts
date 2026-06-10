/**
 * Built-in {@link ObservabilitySink} adapters.
 *
 * These are concrete, dependency-free sinks that ship telemetry to common
 * destinations without forcing users to write their own adapter. Every sink
 * here is workerd-compatible: they use only the global Fetch API and `console`
 * — no bundled SDKs, no Node built-ins.
 *
 * All sinks are defensive: a failing destination (network error, throwing
 * callback) is caught and swallowed so it can never break user-facing RPC
 * dispatch. The runtime's `emitRpcEvent` already wraps `onRpc` in a try/catch,
 * but these adapters also guard their own async work (e.g. a rejected `fetch`
 * promise) since that escapes the synchronous try/catch.
 *
 * Privacy note: an {@link ObservabilityEvent}'s `error.message` is the
 * human-readable error string and MAY contain user input. The
 * {@link webhookSink} ships the full event — including `error.message` — to a
 * third party. Scrub or redact before enabling it against an external service
 * if that is a concern.
 */
import type { LogEvent, ObservabilityEvent, ObservabilitySink } from "./observability";

/** Shared shape for sinks that can be limited to error events only. */
interface OnlyErrorsOption {
    /** When true, only events with `ok === false` are forwarded. */
    onlyErrors?: boolean;
}

/** Returns true when the event should be skipped under an `onlyErrors` filter. */
const shouldSkip = (event: ObservabilityEvent, onlyErrors: boolean | undefined): boolean => onlyErrors === true && event.ok;

/**
 * Case-insensitively merge `overrides` onto `defaults`, with `overrides`
 * winning. HTTP header names are case-insensitive, so a naive object spread of
 * `{ "content-type": ..., ...overrides }` would keep BOTH `content-type` and a
 * user-supplied `Content-Type` as distinct object keys; the `fetch`/`Headers`
 * constructor then *combines* them ("application/json, text/plain") instead of
 * letting the caller override. Normalising the key first guarantees a single,
 * caller-controlled value per header.
 */
const mergeHeaders = (defaults: Record<string, string>, overrides: Record<string, string> | undefined): Record<string, string> => {
    if (!overrides) {
        return { ...defaults };
    }

    const merged: Record<string, string> = {};
    const seen = new Map<string, string>();

    for (const [name, value] of Object.entries(defaults)) {
        const lower = name.toLowerCase();

        seen.set(lower, name);
        merged[name] = value;
    }

    for (const [name, value] of Object.entries(overrides)) {
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
    }

    return merged;
};

/**
 * A sink that logs each event via `console`.
 *
 * Useful as a zero-config default during development, or wired behind
 * {@link combineSinks} alongside a network sink. Successful events are logged
 * with `console.log`; error events (`ok === false`) with `console.error`.
 * @param options Sink options; set `onlyErrors` to log error events only.
 */
export const consoleSink = (options: OnlyErrorsOption = {}): ObservabilitySink => {
    const { onlyErrors } = options;

    return {
        onLog: (event) => {
            // `onlyErrors` filters the RPC summary stream; application log lines
            // are emitted whole so a developer still sees their `ctx.log` output.
            if (event.level === "error") {
                // eslint-disable-next-line no-console
                console.error("[cirrus:log]", event.functionPath, event.message);
            } else {
                // eslint-disable-next-line no-console
                console.log("[cirrus:log]", event.functionPath, event.message);
            }
        },
        onRpc: (event) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            if (event.ok) {
                // eslint-disable-next-line no-console
                console.log("[cirrus:rpc]", event);
            } else {
                // eslint-disable-next-line no-console
                console.error("[cirrus:rpc]", event);
            }
        },
    };
};

/** Options for {@link webhookSink}. */
export interface WebhookSinkOptions extends OnlyErrorsOption {
    /**
     * Extra headers merged onto the POST. `Content-Type: application/json` is
     * set by default and may be overridden here (e.g. to add an
     * `Authorization` / API-key header for Axiom, Datadog, etc.).
     */
    headers?: Record<string, string>;

    /**
     * Optional redaction hook applied to each event immediately before it is
     * serialized and shipped. Use it to scrub or drop PII (e.g. strip
     * `error.message`) before it leaves the worker. Return the (possibly
     * modified) event to send, or `null`/`undefined` to drop the event
     * entirely. A throwing `transform` drops the event (fail-closed) so a buggy
     * redactor can never leak the un-scrubbed payload.
     */
    transform?: (event: ObservabilityEvent) => null | ObservabilityEvent | undefined;
    /** The ingestion endpoint to POST each event to. */
    url: string;
}

/**
 * A fire-and-forget sink that POSTs each event as JSON to an HTTP endpoint.
 *
 * This covers Axiom, Datadog, and any generic webhook/log-ingestion service —
 * point `url` at the ingestion endpoint and supply auth via `headers`. Each
 * event is sent as its own `fetch`; the promise is intentionally not awaited
 * (there is no `ctx.waitUntil` available inside a sink) and its rejection is
 * swallowed so a flaky endpoint never surfaces to the caller.
 *
 * Privacy: the full event is serialized, including `error.message`, which may
 * contain user input. See the module-level note. Pass a `transform` callback to
 * scrub or drop fields before they leave the worker.
 * @param options Sink options: `url` is the POST target, `headers` are merged
 * request headers (e.g. an API key), `onlyErrors` ships error events only, and
 * `transform` redacts/drops each event before send.
 */
export const webhookSink = (options: WebhookSinkOptions): ObservabilitySink => {
    const { headers, onlyErrors, transform, url } = options;
    const mergedHeaders = mergeHeaders({ "content-type": "application/json" }, headers);

    return {
        onRpc: (event) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            try {
                let payload: null | ObservabilityEvent | undefined = event;

                if (transform) {
                    // Fail-closed: if the redactor throws we drop the event
                    // rather than ship the un-scrubbed original.
                    try {
                        payload = transform(event);
                    } catch {
                        return;
                    }
                }

                if (payload === null || payload === undefined) {
                    return;
                }

                // Fire-and-forget: no await. The `.catch` swallows any
                // rejection so a failed POST can never reject into the dispatch
                // path. The settled promise is intentionally not retained.
                const sent = fetch(url, {
                    body: JSON.stringify(payload),
                    headers: mergedHeaders,
                    method: "POST",
                });

                sent.catch(() => {
                    // Network error / non-OK response — intentionally ignored.
                });
            } catch {
                // `fetch` itself throwing synchronously (e.g. an invalid URL)
                // must not break dispatch either.
            }
        },
    };
};

/** Options for {@link sentrySink}. */
export interface SentrySinkOptions extends OnlyErrorsOption {
    /**
     * User-supplied capture callback. Wire this to your Sentry client, e.g.
     * `(event) => Sentry.captureMessage(...)` or `captureException`. Kept as an
     * injected callback so the runtime takes no dependency on `@sentry/*`.
     */
    capture: (event: ObservabilityEvent) => void;
}

/**
 * A thin adapter that forwards events to an injected `capture` callback.
 *
 * Intentionally does NOT bundle `@sentry/*`: the user wires their own Sentry
 * client (`captureException` / `captureMessage`) into `capture`, giving Sentry
 * parity without a hard dependency. The callback is invoked inside a try/catch
 * so a throwing client can't break dispatch.
 * @param options Sink options: `capture` is invoked per forwarded event;
 * `onlyErrors` defaults to true (error events only) — pass `false` for all.
 */
export const sentrySink = (options: SentrySinkOptions): ObservabilitySink => {
    const { capture } = options;
    // Sentry defaults to error-only — capturing every successful RPC as an
    // event would flood the project. Callers opt into all events explicitly.
    const onlyErrors = options.onlyErrors ?? true;

    return {
        onRpc: (event) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            try {
                capture(event);
            } catch {
                // A throwing capture callback must not break dispatch.
            }
        },
    };
};

/** One Analytics Engine data point — the structural subset {@link analyticsEngineSink} writes. */
export interface AnalyticsEngineDataPointLike {
    /** Free-form string dimensions (≤20, ≤5120 bytes total). */
    blobs?: (null | string)[];
    /** Numeric metrics (≤20). */
    doubles?: number[];
    /** Sampling key(s) — Analytics Engine accepts a single index (≤96 bytes). */
    indexes?: (null | string)[];
}

/**
 * The Cloudflare Analytics Engine dataset binding surface this sink needs — the
 * `env` binding declared in `wrangler.jsonc` under `analytics_engine_datasets`.
 * Typed structurally so the runtime takes no dependency on
 * `@cloudflare/workers-types`.
 */
export interface AnalyticsEngineDatasetLike {
    writeDataPoint: (point: AnalyticsEngineDataPointLike) => void;
}

/** Options for {@link analyticsEngineSink}. */
export interface AnalyticsEngineSinkOptions extends OnlyErrorsOption {
    /** The Analytics Engine dataset binding to write each event to. */
    dataset: AnalyticsEngineDatasetLike;
}

/**
 * A sink that writes each event to a Cloudflare Analytics Engine dataset.
 *
 * Analytics Engine is the platform's unbounded-cardinality, sampled time-series
 * store — the natural backing for high-volume RPC observability metrics, queried
 * later over SQL. Prefer it over rolling your own counters table for anything
 * that doesn't need to be exact. Each event maps to one data point.
 *
 * indexes: `[functionPath]` — the sampling key, so Analytics Engine samples per
 * function rather than globally.
 *
 * blobs (string dimensions): `[functionPath, ok-or-error, shardKey, error.code,
 * fanOut.table]` — group/filter dimensions; absent fields are the empty string.
 *
 * doubles (numeric metrics): `[durationMs, errorCount, fanOut.shards,
 * fanOut.failed]` where errorCount is 0 or 1 — so `SUM(double2)` is the error
 * count and `AVG(double1)` the latency.
 *
 * `writeDataPoint` is fire-and-forget on the platform; the call is still wrapped
 * in a try/catch so a missing/throwing binding can never break dispatch.
 * @param options Sink options: `dataset` is the AE binding; `onlyErrors` writes
 * only error events (defaults to all events).
 */
export const analyticsEngineSink = (options: AnalyticsEngineSinkOptions): ObservabilitySink => {
    const { dataset, onlyErrors } = options;

    return {
        onRpc: (event) => {
            if (shouldSkip(event, onlyErrors)) {
                return;
            }

            try {
                dataset.writeDataPoint({
                    blobs: [event.functionPath, event.ok ? "ok" : "error", event.shardKey ?? "", event.error?.code ?? "", event.fanOut?.table ?? ""],
                    doubles: [event.durationMs, event.ok ? 0 : 1, event.fanOut?.shards ?? 0, event.fanOut?.failed ?? 0],
                    indexes: [event.functionPath],
                });
            } catch {
                // A missing or throwing dataset binding must not break dispatch.
            }
        },
    };
};

/**
 * Combine several sinks into one that fans each event out to all of them.
 *
 * Each child sink is invoked in order; a throw from one does not prevent the
 * others from running (each call is individually guarded).
 * @param sinks The sinks to fan out to.
 */
export const combineSinks = (...sinks: ObservabilitySink[]): ObservabilitySink => {
    return {
        onLog: (event: LogEvent) => {
            for (const sink of sinks) {
                if (!sink.onLog) {
                    continue;
                }

                try {
                    sink.onLog(event);
                } catch {
                    // Isolate failures so one bad sink doesn't starve the rest.
                }
            }
        },
        onRpc: (event) => {
            for (const sink of sinks) {
                if (!sink.onRpc) {
                    continue;
                }

                try {
                    sink.onRpc(event);
                } catch {
                    // Isolate failures so one bad sink doesn't starve the rest.
                }
            }
        },
    };
};
