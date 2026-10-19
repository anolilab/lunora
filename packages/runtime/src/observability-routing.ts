/**
 * Composable sink wrappers: derive extra attributes for every event a sink
 * receives (`enrichSink`), and route signals by function path (`filterSink`).
 *
 * Each wrapper returns an ordinary `ObservabilitySink`, so it drops in wherever a
 * sink goes. Both halves of the telemetry get it: the worker's
 * `createWorker({ observability })` (the RPC event) and the shard's
 * `createShardDO` (`ctx.log`, `ctx.trace`, `ctx.metrics`), because an app hands
 * the same sink object to both.
 *
 * A wrapper copies the sink's configuration fields (`traceFetch` and the rest,
 * see `SINK_CONFIG_FIELDS`) and defines a hook only when the wrapped sink defines
 * it, so an absent `onSpan` stays absent. Errors thrown by the wrapped sink are
 * swallowed, as `combineSinks` does.
 */
import { redactArgs, redactSecrets } from "@lunora/observability";

import type { LogFields } from "../../../shared/log-fields";
import { normalizeLogFields } from "../../../shared/log-fields";
import type { LogEvent, MetricEvent, ObservabilityEvent, ObservabilitySink, ObservabilitySinkContext, SpanEvent } from "./observability";
import { SINK_CONFIG_FIELDS } from "./observability-sinks";

/** The four signal kinds a sink receives. */
type SinkSignalKind = "log" | "metric" | "rpc" | "span";

/** Any event a sink receives. Every variant carries `functionPath`. */
type SinkEvent = LogEvent | MetricEvent | ObservabilityEvent | SpanEvent;

/**
 * Derives extra attributes for one event. Return `undefined` (or an empty bag)
 * to add nothing.
 *
 * The result is normalized to JSON-safe primitives and redacted the way the signal's
 * own fields are: `redactArgs` for log lines, and the credential-only `redactSecrets`
 * for metrics, spans and RPC events, whose ids and URLs the PII rules would erase. It
 * is merged UNDER the event's own attributes: a key the event already sets keeps its value.
 *
 * If the enricher throws, the event is delivered unchanged and the failure is logged
 * (a bounded number of times per isolate). Enrichment only adds fields and never removes
 * or reveals anything, so failing open is safe here. Unlike a `postProcessor`, which fails
 * closed because it is a privacy control.
 */
type SinkEnricher = (event: SinkEvent, signal: SinkSignalKind) => LogFields | undefined;

/**
 * Route signals by `functionPath`, using `*` as the only wildcard (any run of
 * characters, including `:` and `/`). Matching is case-sensitive.
 *
 * - `exclude` always wins over `include`.
 * - An absent or empty `include` matches every path.
 *
 * Signals recorded by the platform carry synthetic paths such as `alarm:rearm`,
 * `scheduler:outbox`, `ttl:sweep` and `container:<name>`. An `include` list drops
 * them unless one of its patterns matches, so list them explicitly to keep them.
 */
interface SinkRouteOptions {
    /** Patterns that drop a path, even when `include` matches it. */
    exclude?: string[];
    /** Patterns a path must match to pass. Absent or empty passes everything. */
    include?: string[];
}

/** Hook-level rewrite: return the event to forward (possibly a copy), or `undefined` to drop it. */
interface SinkRewrite {
    log?: (event: LogEvent) => LogEvent | undefined;
    metric?: (event: MetricEvent) => MetricEvent | undefined;
    rpc?: (event: ObservabilityEvent) => ObservabilityEvent | undefined;
    span?: (event: SpanEvent) => SpanEvent | undefined;
}

/** Run one side effect, swallowing any throw, as `emitRpcEvent` does. */
const guard = (run: () => void): void => {
    try {
        run();
    } catch {
        // Swallow — a buggy sink must not break dispatch.
    }
};

/**
 * Build a sink that forwards to `sink` through `rewrite`. Only hooks the wrapped
 * sink defines are defined on the result.
 */
const wrapSink = (sink: ObservabilitySink, rewrite: SinkRewrite): ObservabilitySink => {
    const wrapped: Record<string, unknown> = {};

    for (const field of SINK_CONFIG_FIELDS) {
        if (sink[field] !== undefined) {
            wrapped[field] = sink[field];
        }
    }

    if (sink.flush) {
        wrapped.flush = (context?: ObservabilitySinkContext) => {
            guard(() => sink.flush?.(context));
        };
    }

    if (sink.onLog) {
        wrapped.onLog = (event: LogEvent, context?: ObservabilitySinkContext) => {
            const next = rewrite.log === undefined ? event : rewrite.log(event);

            if (next !== undefined) {
                guard(() => sink.onLog?.(next, context));
            }
        };
    }

    if (sink.onMetric) {
        wrapped.onMetric = (event: MetricEvent, context?: ObservabilitySinkContext) => {
            const next = rewrite.metric === undefined ? event : rewrite.metric(event);

            if (next !== undefined) {
                guard(() => sink.onMetric?.(next, context));
            }
        };
    }

    if (sink.onRpc) {
        wrapped.onRpc = (event: ObservabilityEvent, context?: ObservabilitySinkContext) => {
            const next = rewrite.rpc === undefined ? event : rewrite.rpc(event);

            if (next !== undefined) {
                guard(() => sink.onRpc?.(next, context));
            }
        };
    }

    if (sink.onSpan) {
        wrapped.onSpan = (event: SpanEvent, context?: ObservabilitySinkContext) => {
            const next = rewrite.span === undefined ? event : rewrite.span(event);

            if (next !== undefined) {
                guard(() => sink.onSpan?.(next, context));
            }
        };
    }

    return wrapped;
};

/** Enricher failures logged on this isolate; the cap keeps a broken enricher from flooding the log. */
const MAX_ENRICHER_FAILURE_REPORTS = 5;
let enricherFailureReports = 0;

const reportEnricherFailure = (error: unknown): void => {
    if (enricherFailureReports >= MAX_ENRICHER_FAILURE_REPORTS) {
        return;
    }

    enricherFailureReports += 1;

    const silencing = enricherFailureReports === MAX_ENRICHER_FAILURE_REPORTS ? " Further enricher failures are silenced until the isolate restarts." : "";

    // Only the error's name is logged: its message can carry the very credential the
    // enricher was handling, and the event itself is delivered unchanged either way.
    // eslint-disable-next-line no-console
    console.error(
        `[lunora:observability] enrichSink's enricher threw; delivering the event without its extra attributes.${silencing}`,
        error instanceof Error ? error.name : typeof error,
    );
};

/**
 * Turn a top-level `Error` value into a record of its name, message and enumerable fields,
 * so redaction sees its message. `normalizeLogFields` serializes nested objects as JSON,
 * which already leaves a nested message out.
 */
const flattenErrorValues = (bag: LogFields): LogFields =>
    Object.fromEntries(
        Object.entries(bag).map(([key, value]) => [
            key,
            value instanceof Error ? { ...Object.fromEntries(Object.entries(value)), message: value.message, name: value.name } : value,
        ]),
    );

/**
 * Run the enricher over one event and return the normalized, redacted bag, or
 * `undefined` when there is nothing to add (no bag, an empty bag, or a throw).
 */
const enrichmentFor = (enrich: SinkEnricher, event: SinkEvent, signal: SinkSignalKind): LogFields | undefined => {
    try {
        // Redact before normalizing: normalizing turns nested objects into JSON strings,
        // which the key-aware redactor can no longer see into. A throw anywhere here,
        // including in normalizing, leaves the event unchanged rather than dropped.
        const derived = enrich(event, signal);
        const flat = derived === undefined ? undefined : flattenErrorValues(derived);
        const redacted = signal === "log" ? redactArgs(flat) : redactSecrets(flat);

        return normalizeLogFields(redacted as LogFields | undefined);
    } catch (error) {
        reportEnricherFailure(error);

        return undefined;
    }
};

/**
 * Wrap a sink so every event it receives carries the enricher's attributes: log
 * lines under `fields`, and metrics, spans and RPC events under `attributes`.
 *
 * The result is a fresh object per event, never a mutation, because one event
 * object fans out to every `combineSinks` child and to the shard's local buffers.
 * @param sink The sink to deliver enriched events to.
 * @param enrich Derives the extra attributes for each event.
 */
const enrichSink = (sink: ObservabilitySink, enrich: SinkEnricher): ObservabilitySink =>
    wrapSink(sink, {
        log: (event) => {
            const extra = enrichmentFor(enrich, event, "log");

            return extra === undefined ? event : { ...event, fields: { ...extra, ...event.fields } };
        },
        metric: (event) => {
            const extra = enrichmentFor(enrich, event, "metric");

            return extra === undefined ? event : { ...event, attributes: { ...extra, ...event.attributes } };
        },
        rpc: (event) => {
            const extra = enrichmentFor(enrich, event, "rpc");

            return extra === undefined ? event : { ...event, attributes: { ...extra, ...event.attributes } };
        },
        span: (event) => {
            const extra = enrichmentFor(enrich, event, "span");

            return extra === undefined ? event : { ...event, attributes: { ...extra, ...event.attributes } };
        },
    });

/**
 * Glob match for `functionPath` patterns. `*` matches any run of characters
 * (including `:` and `/`); there is no other metacharacter. Written without a
 * regex, so no pattern can backtrack.
 * @param pattern The pattern, e.g. `messages:*`.
 * @param value The function path to test, e.g. `messages:list`.
 */
const globMatch = (pattern: string, value: string): boolean => {
    const segments = pattern.split("*");

    if (segments.length === 1) {
        return value === pattern;
    }

    const first = segments[0] ?? "";
    const last = segments.at(-1) ?? "";

    if (value.length < first.length + last.length || !value.startsWith(first) || !value.endsWith(last)) {
        return false;
    }

    // The literal middle segments must appear in order, between the anchored ends.
    const end = value.length - last.length;
    let cursor = first.length;

    for (const segment of segments.slice(1, -1)) {
        const found = value.indexOf(segment, cursor);

        if (found === -1 || found + segment.length > end) {
            return false;
        }

        cursor = found + segment.length;
    }

    return cursor <= end;
};

/** Whether `functionPath` passes the route options. */
const routeAllows = (functionPath: string, options: SinkRouteOptions): boolean => {
    if (options.exclude?.some((pattern) => globMatch(pattern, functionPath))) {
        return false;
    }

    return options.include === undefined || options.include.length === 0 || options.include.some((pattern) => globMatch(pattern, functionPath));
};

/**
 * Wrap a sink so it receives only the signals whose `functionPath` passes the
 * route options. Applies to all four signal kinds, since each carries a path.
 * A dropped event never reaches the wrapped sink, and no enricher runs for it
 * when `filterSink` wraps an `enrichSink`.
 * @param sink The sink to deliver the routed events to.
 * @param options The include and exclude patterns. See `SinkRouteOptions`.
 */
const filterSink = (sink: ObservabilitySink, options: SinkRouteOptions): ObservabilitySink => {
    const keep = <E extends { functionPath: string }>(event: E): E | undefined => (routeAllows(event.functionPath, options) ? event : undefined);

    return wrapSink(sink, { log: keep, metric: keep, rpc: keep, span: keep });
};

export type { SinkEnricher, SinkEvent, SinkRouteOptions, SinkSignalKind };
export { enrichSink, filterSink, globMatch };
