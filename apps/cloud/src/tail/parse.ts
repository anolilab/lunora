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

/**
 * Plain console lines kept per script per flush (one `tail()` delivery). Past
 * it, the rest are counted into one marker line ({@link droppedMarker}) — a
 * chatty plain Worker is bounded here, and per organization at ingest.
 */
export const MAX_PLAIN_LINES_PER_SCRIPT = 400;

/** Lines per batch the control plane ingests in one call — `MAX_BATCH` in `lunora/logs.ts`, which refuses a larger one. */
export const MAX_INGEST_LINES = 500;

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
 * One tail `TraceItem`'s console logs, decoded: every lunora `type:"log"` line
 * and, for a script tagged as a plain Worker, at most `allowance` of its other
 * console lines — the rest counted in `dropped`.
 */
const decodeTraceItem = (item: TailTraceItem, allowance: number): { dropped: number; lines: TailLogLine[]; plain: number } => {
    const plainWorker = item.scriptTags?.includes(WORKER_RUNTIME_TAG) === true;
    const lines: TailLogLine[] = [];
    let plain = 0;
    let dropped = 0;

    for (const log of item.logs ?? []) {
        const line = parseLogMessage(log.message);
        const fallback = line === null && plainWorker ? parsePlainLog(log) : null;

        if (line !== null) {
            lines.push(line);
        } else if (fallback !== null && plain < allowance) {
            plain += 1;
            lines.push(fallback);
        } else if (fallback !== null) {
            dropped += 1;
        }
    }

    return { dropped, lines, plain };
};

/**
 * Decode every lunora `type:"log"` line out of one tail `TraceItem` and, for a
 * script tagged as a plain Worker, its other console lines too (at most
 * {@link MAX_PLAIN_LINES_PER_SCRIPT}; {@link groupTailEvents} holds a whole flush to that).
 */
export const parseTraceItem = (item: TailTraceItem): TailLogLine[] => decodeTraceItem(item, MAX_PLAIN_LINES_PER_SCRIPT).lines;

/** The line that says how many console lines a flush dropped, so a gap in the Logs tab is never silent. */
const droppedMarker = (dropped: number): TailLogLine => {
    return {
        level: "warn",
        message: `${String(dropped)} console line(s) dropped from one log flush: Lunora Cloud keeps at most ${String(MAX_PLAIN_LINES_PER_SCRIPT)} plain console lines per Worker per flush`,
    };
};

/** One script's decoded lines, ready for `POST /v1/logs/tail`. */
export interface TailBatch {
    lines: TailLogLine[];
    scriptName: string;
}

/**
 * Group a whole tail event array into per-script batches, dropping items with no
 * script name and scripts with no line to keep. A plain Worker keeps at most
 * {@link MAX_PLAIN_LINES_PER_SCRIPT} console lines per flush, plus a line
 * counting the rest; each script's lines are split into batches of at most
 * {@link MAX_INGEST_LINES}, so one script may send several. The producer POSTs
 * these to the control plane, which resolves each `scriptName` → org and ingests
 * each batch on its own.
 */
export const groupTailEvents = (events: TailTraceItem[]): TailBatch[] => {
    const byScript = new Map<string, { dropped: number; lines: TailLogLine[]; plain: number }>();

    for (const item of events) {
        const { scriptName } = item;

        if (scriptName === null || scriptName === undefined || scriptName === "") {
            continue;
        }

        const entry = byScript.get(scriptName) ?? { dropped: 0, lines: [], plain: 0 };
        const decoded = decodeTraceItem(item, MAX_PLAIN_LINES_PER_SCRIPT - entry.plain);

        byScript.set(scriptName, { dropped: entry.dropped + decoded.dropped, lines: [...entry.lines, ...decoded.lines], plain: entry.plain + decoded.plain });
    }

    // Chunked to what one ingest call takes: a larger batch is refused whole.
    return [...byScript.entries()].flatMap(([scriptName, { dropped, lines }]) => {
        const all = dropped > 0 ? [...lines, droppedMarker(dropped)] : lines;
        const batches: TailBatch[] = [];

        for (let index = 0; index < all.length; index += MAX_INGEST_LINES) {
            batches.push({ lines: all.slice(index, index + MAX_INGEST_LINES), scriptName });
        }

        return batches;
    });
};
