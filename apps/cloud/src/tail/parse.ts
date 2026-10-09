/**
 * Pure decoders for the dispatch-namespace tail worker (`worker.ts`). A tenant
 * worker emits each `ctx.log` line as a single `console.log(JSON.stringify(...))`
 * with the shape `{ source: "lunora", type: "log", … }` (see the framework's
 * `emitLogEvent` in `@lunora/do`'s `request-log.ts`). Cloudflare's tail delivers
 * that to a tail consumer as one `TraceItemLog` whose `message` is the console
 * args array — here `[&lt;json string>]`.
 *
 * These functions turn that back into a structured {@link TailLogLine} the
 * platform ingest (`logs.ingestInternal`) stores. Kept pure and dependency-free
 * so they unit-test without a live tail, and tolerant — a non-lunora line, a
 * plain `console.log`, or a malformed payload is skipped, never thrown on.
 *
 * Except for a plain Cloudflare Worker (`runtime: "worker"`), which emits no
 * `ctx.log` events at all: its script carries the `runtime:worker` tag, and for
 * it every ordinary console line is kept too ({@link parsePlainLog}), shaped
 * like the rest — level, message, timestamp — so the Logs tab reads the same.
 */
import { WORKER_RUNTIME_TAG } from "../project-runtime";

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

/** Longest plain console line kept — `logs.ingestInternal` truncates past the same. */
const MAX_PLAIN_MESSAGE_CHARS = 4096;

/** Plain console lines kept per trace item: one request's output, not a flood that would fail the whole batch at ingest. */
const MAX_PLAIN_LINES_PER_ITEM = 200;

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
 * as the raw `[&lt;json string>]` args array or as the JSON string directly.
 */
export const parseLogMessage = (message: unknown): TailLogLine | null => {
    // A tail message arrives either as a single-element array of strings (the
    // common `console.log("…")` shape) or as a bare value.
    const soleString = Array.isArray(message) && message.length === 1 && typeof message[0] === "string" ? message[0] : undefined;
    const text = Array.isArray(message) ? soleString : asString(message);

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

/** One console call as a tail `TraceItem` carries it: Cloudflare's `level`, the call's arguments, and when. */
export interface TailLog {
    level?: unknown;
    message?: unknown;
    timestamp?: unknown;
}

/** The subset of a Cloudflare tail `TraceItem` this worker reads. */
export interface TailTraceItem {
    logs?: TailLog[];
    scriptName?: null | string;
    /** The script's tags (dispatch-namespace scripts): `runtime:worker` marks a plain Cloudflare Worker. */
    scriptTags?: null | string[];
}

/** One console argument as text: a string as written, anything else as its JSON. */
const argumentText = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }

    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};

/**
 * Decode an ordinary console line — what a plain Worker's `console.log("a", 1)`
 * becomes — into a {@link TailLogLine}: the arguments joined by a space, as a
 * terminal prints them, at Cloudflare's level (`log`, `info`, `warn`, `error`,
 * `debug`; anything else is `log`). `null` for a line with nothing in it.
 */
export const parsePlainLog = (log: TailLog): TailLogLine | null => {
    const parts = Array.isArray(log.message) ? log.message : [log.message];
    const message = parts
        .filter((part) => part !== undefined)
        .map((part) => argumentText(part))
        .join(" ")
        .slice(0, MAX_PLAIN_MESSAGE_CHARS);

    if (message.trim() === "") {
        return null;
    }

    return {
        ...(typeof log.timestamp === "number" ? { createdAt: log.timestamp } : {}),
        level: asLevel(log.level),
        message,
    };
};

/**
 * Decode one tail `TraceItem`'s console logs: every lunora `type:"log"` line
 * and, for a script tagged as a plain Worker, every other console line too
 * (at most {@link MAX_PLAIN_LINES_PER_ITEM} of those per item).
 */
export const parseTraceItem = (item: TailTraceItem): TailLogLine[] => {
    const plainWorker = item.scriptTags?.includes(WORKER_RUNTIME_TAG) === true;
    const lines: TailLogLine[] = [];
    let plain = 0;

    for (const log of item.logs ?? []) {
        const line = parseLogMessage(log.message);

        if (line) {
            lines.push(line);
        } else if (plainWorker && plain < MAX_PLAIN_LINES_PER_ITEM) {
            const kept = parsePlainLog(log);

            if (kept) {
                plain += 1;
                lines.push(kept);
            }
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
        const { scriptName } = item;

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

    return [...byScript.entries()].map(([scriptName, lines]) => {
        return { lines, scriptName };
    });
};
