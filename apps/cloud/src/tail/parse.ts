/**
 * Pure decoders for the dispatch-namespace tail worker (`worker.ts`). A tenant
 * worker emits each `ctx.log` line as a single `console.log(JSON.stringify(...))`
 * with the shape `{ source: "lunora", type: "log", … }` (see the framework's
 * `emitLogEvent` in `@lunora/do`'s `request-log.ts`). Cloudflare's tail delivers
 * that to a tail consumer as one `TraceItemLog` whose `message` is the console
 * args array — here `[<json string>]`.
 *
 * These functions turn that back into a structured {@link TailLogLine} the
 * platform ingest (`logs.ingestInternal`) stores. Kept pure and dependency-free
 * so they unit-test without a live tail, and tolerant — a non-lunora line, a
 * plain `console.log`, or a malformed payload is skipped, never thrown on.
 */

/** The seven-tier `ctx.log` severity ramp — mirrors the framework's `ContextLogLevel`. */
export type LogLevel = "debug" | "error" | "fatal" | "info" | "log" | "trace" | "warn";

/** One decoded log line, matching the shape `logs.ingestInternal` accepts. */
export interface TailLogLine {
    createdAt?: number;
    fields?: Record<string, unknown>;
    functionPath?: string;
    level: LogLevel;
    message: string;
    shardKey?: string;
    spanId?: string;
    traceId?: string;
    userId?: string;
}

/** Marker present in every lunora console event (`JSON.stringify` emits no spaces around the colon). */
const LUNORA_MARKER = '"source":"lunora"';

/** Valid `ctx.log` severities; an unrecognized level folds to `log` (the default tier). */
const LEVELS = new Set<LogLevel>(["debug", "error", "fatal", "info", "log", "trace", "warn"]);

/** True for a plain object usable as a structured-fields bag (not null, not an array). */
const isFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a string property, or `undefined` when absent/non-string. */
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Coerce a raw event level to a known {@link LogLevel}; unknown/absent → `log`. */
const asLevel = (value: unknown): LogLevel => (typeof value === "string" && LEVELS.has(value as LogLevel) ? (value as LogLevel) : "log");

/**
 * Decode one tail log message (the console args array) into a {@link TailLogLine},
 * or `null` when it isn't a lunora `type:"log"` event. Accepts the message either
 * as the raw `[<json string>]` args array or as the JSON string directly.
 */
export const parseLogMessage = (message: unknown): TailLogLine | null => {
    const text = Array.isArray(message) ? (message.length === 1 && typeof message[0] === "string" ? message[0] : undefined) : asString(message);

    if (text === undefined) {
        return null;
    }

    const trimmed = text.trim();

    // Fast reject: every lunora event is a single JSON object carrying the marker.
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || !trimmed.includes(LUNORA_MARKER)) {
        return null;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }

    const event = parsed as Record<string, unknown>;

    if (event.source !== "lunora" || event.type !== "log") {
        return null;
    }

    return {
        createdAt: typeof event.ts === "number" ? event.ts : undefined,
        fields: isFields(event.fields) ? event.fields : undefined,
        functionPath: asString(event.function),
        level: asLevel(event.level),
        message: asString(event.message) ?? "",
        shardKey: asString(event.shard),
        spanId: asString(event.spanId),
        traceId: asString(event.traceId),
        userId: asString(event.userId),
    };
};

/** The subset of a Cloudflare tail `TraceItem` this worker reads. */
export interface TailTraceItem {
    logs?: { message?: unknown }[];
    scriptName?: null | string;
}

/** Decode every lunora `type:"log"` line out of one tail `TraceItem`'s console logs. */
export const parseTraceItem = (item: TailTraceItem): TailLogLine[] => {
    const lines: TailLogLine[] = [];

    for (const log of item.logs ?? []) {
        const line = parseLogMessage(log.message);

        if (line) {
            lines.push(line);
        }
    }

    return lines;
};

/** One script's decoded lines, ready for `POST /v1/logs/tail`. */
export interface TailBatch {
    lines: TailLogLine[];
    scriptName: string;
}

/**
 * Group a whole tail event array into per-script batches, dropping items with no
 * script name or no lunora log lines. The producer POSTs these to the control
 * plane, which resolves each `scriptName` → org.
 */
export const groupTailEvents = (events: TailTraceItem[]): TailBatch[] => {
    const byScript = new Map<string, TailLogLine[]>();

    for (const item of events) {
        const scriptName = item.scriptName;

        if (scriptName === null || scriptName === undefined || scriptName === "") {
            continue;
        }

        const lines = parseTraceItem(item);

        if (lines.length === 0) {
            continue;
        }

        const existing = byScript.get(scriptName);

        if (existing) {
            existing.push(...lines);
        } else {
            byScript.set(scriptName, lines);
        }
    }

    return [...byScript.entries()].map(([scriptName, lines]) => ({ lines, scriptName }));
};
