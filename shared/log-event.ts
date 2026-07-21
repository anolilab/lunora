/**
 * Shared, bundler-inlined contract for one application log line (`ctx.log.*`).
 *
 * `@lunora/do` builds these events and hands them to a `@lunora/runtime`
 * `ObservabilitySink.onLog`, but `@lunora/do` has no dependency on
 * `@lunora/runtime` — so before this file the event shape and the seven-tier
 * severity union were hand-mirrored (and widened in lockstep) in both packages.
 * Hosting them here (inlined into each `dist`, like {@link file://./otlp.ts})
 * makes the cross-package `onLog` call structurally guaranteed instead of
 * coincidentally compatible, and gives the level union + its severity ordering a
 * single source of truth. Keep genuinely zero-dependency so inlining stays sound.
 */
import type { LogFields } from "./log-fields";

/**
 * Severity of a `ctx.log.*` call. The five console method names (`log` is the
 * default level, distinct from `info`) plus `trace`/`fatal`, so the logger spans
 * the full OpenTelemetry severity ramp (`trace`→`fatal`).
 */
export type ContextLogLevel = "debug" | "error" | "fatal" | "info" | "log" | "trace" | "warn";

/**
 * Per-event context handed to a sink alongside the event: lets a sink register
 * background work (a telemetry POST, a durable pipeline send) with the request's
 * `waitUntil` so it survives isolate teardown after the response returns. Absent
 * `waitUntil` (no request context) means the sink falls back to fire-and-forget.
 */
export interface LogSinkContext {
    /** Keep a background promise alive past the response (the request's `waitUntil`). */
    waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * One application log line emitted from a function handler via `ctx.log`.
 * Produced per `ctx.log.*` call (unlike a per-dispatch RPC summary).
 */
export interface LogEvent {
    /** Raw arguments passed to the `ctx.log.*` call, in order. */
    args: unknown[];
    /**
     * Structured fields the caller attached (`ctx.log.info(message, fields)` or a
     * bound `ctx.log.with(fields)` child), already normalized to a fresh bag of
     * JSON-safe primitives (see `shared/log-fields.ts`). Absent for a plain
     * console-style call.
     */
    fields?: LogFields;
    /** Function path that emitted the line, e.g. `"messages:list"`. */
    functionPath: string;
    /** Severity the line was logged at. */
    level: ContextLogLevel;
    /** Display string — the message, or the console-style args rendered and space-joined. */
    message: string;
    /** Shard key for single-shard calls; absent for the unnamed root DO. */
    shardKey?: string;
    /** Span id of the RPC this line was emitted under (trace correlation), or absent. */
    spanId?: string;
    /** Trace id this line belongs to (from the inbound `traceparent`), or absent. */
    traceId?: string;
    /** Wall-clock millis when the line was emitted. */
    ts: number;
    /** Acting userId, or absent when anonymous. */
    userId?: string;
}

/**
 * The seven severities in ascending order, so a renderer (the Studio Logs panel's
 * level chips and its grouped summary) can present them ramp-ordered without
 * re-deriving the ordering from the alphabetically-sorted union.
 */
export const LOG_LEVEL_ORDER: readonly ContextLogLevel[] = ["trace", "debug", "log", "info", "warn", "error", "fatal"];
