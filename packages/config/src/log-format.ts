/**
 * Shared formatter for the structured log events the Lunora runtime emits to the
 * worker's `console` during development. Both the CLI `dev` command and the Vite
 * plugin pipe worker output through `formatLunoraEvent` so a developer sees
 * attributed, readable lines instead of raw JSON.
 *
 * The runtime emits two event shapes, each a single `console` line tagged
 * `source: "lunora"` (see `@lunora/do`'s `request-log.ts`): a `type: "log"`
 * event per `ctx.log.*` call, and a `type: "request"` event per RPC dispatch
 * (opt-in for successful calls, always for errors).
 *
 * This module is intentionally dependency-free and colour-free: it returns the
 * severity plus a plain display string, leaving ANSI/level colouring to each
 * caller (the CLI routes through its `pail` logger; the Vite plugin dims inline).
 * Any line that is not a lunora event returns `undefined`, signalling the caller
 * to pass it through unchanged.
 *
 * The one import is the bundler-inlined, zero-dependency `shared/log-fields.ts`
 * field renderer (shared with the runtime sinks and the Studio panel so the
 * `key=value` rendering isn't hand-mirrored), which keeps this module's
 * dependency-free property intact.
 */
import { formatLogFields } from "../../../shared/log-fields";

/** Severity a formatted line should be surfaced at, mapped onto the three logger channels. */
type LunoraLineLevel = "error" | "info" | "warn";

/** A formatted lunora event: the channel to surface it on, the display text, and which event produced it. */
interface LunoraFormattedLine {
    /** `"log"` for a `ctx.log.*` line, `"rpc"` for a dispatch summary. */
    kind: "log" | "rpc";
    /** Logger channel — callers colour by this. */
    level: LunoraLineLevel;
    /** Human-readable, colour-free line content (no `[lunora]` tag — callers add their own). */
    text: string;
}

/** Stable `source` tag every lunora console event carries. Mirrors `REQUEST_LOG_EVENT_SOURCE` in `@lunora/do`. */
const LUNORA_EVENT_SOURCE = "lunora";

/**
 * Internal name of the unnamed default Durable Object (the single-DO topology).
 * Mirrors `ROOT_SHARD_NAME` in `@lunora/do`. A dispatch against it is *not*
 * sharded from the developer's point of view, so the formatter treats this
 * sentinel as "no shard" and never appends a noisy `@__root__` suffix.
 */
const ROOT_SHARD_NAME = "__root__";

/** Raw shape of a parsed lunora event line; fields are validated before use. */
interface LunoraEvent {
    cacheHit?: unknown;
    /** `type: "container"` — the container export name. */
    container?: unknown;
    durationMs?: unknown;
    error?: unknown;
    /** `type: "container"` — the lifecycle transition (`start`/`stop`/`error`). */
    event?: unknown;
    /** `type: "log"` — structured fields from `ctx.log.&lt;level>(msg, fields)` / `ctx.log.with(fields)`. */
    fields?: unknown;
    function?: unknown;
    /** `type: "container"` — the per-instance id (Durable Object id). */
    instance?: unknown;
    level?: unknown;
    message?: unknown;
    outcome?: unknown;
    shard?: unknown;
    source?: unknown;
    /** `type: "log"` — the dispatch span id, for trace correlation. */
    spanId?: unknown;
    tablesRead?: unknown;
    tablesWritten?: unknown;
    /** `type: "log"` — the trace id this line belongs to. */
    traceId?: unknown;
    type?: unknown;
}

/** Coerce an unknown to a string, or `""` when it isn't a string. */
const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Coerce an unknown table list to `string[]`, dropping non-string members. */
const asStringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** Render a duration as a compact `Nms` (integer millis); `?ms` when the value is missing/non-numeric. */
const formatDuration = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? `${String(Math.round(value))}ms` : "?ms");

/** Map a raw `ctx.log` level string onto one of the three logger channels. */
const toLineLevel = (rawLevel: string): LunoraLineLevel => {
    // `fatal` is the most severe tier — surface it on the error channel.
    if (rawLevel === "error" || rawLevel === "fatal") {
        return "error";
    }

    if (rawLevel === "warn") {
        return "warn";
    }

    // `trace` / `debug` / `info` / `log` all read as informational in the terminal.
    return "info";
};

/** Parse a worker-output line into a lunora event, or `undefined` when it isn't one. Never throws. */
const parseLunoraEvent = (line: string): LunoraEvent | undefined => {
    const trimmed = line.trim();

    // Fast reject: every lunora event is a single JSON object literal.
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return undefined;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return undefined;
    }

    const event: LunoraEvent = parsed;

    return event.source === LUNORA_EVENT_SOURCE ? event : undefined;
};

/**
 * Attribution label: `function@shard` when a *real* shard key is present, else
 * the bare function path. The default single-DO root ({@link ROOT_SHARD_NAME})
 * is treated as no shard so the common case reads `function`, not `function@__root__`.
 */
const labelFor = (functionPath: string, event: LunoraEvent): string => {
    const shard = asString(event.shard);

    return shard === "" || shard === ROOT_SHARD_NAME ? functionPath : `${functionPath}@${shard}`;
};

/** Format a `type: "request"` dispatch summary. */
const formatRequest = (event: LunoraEvent, functionPath: string): LunoraFormattedLine => {
    const failed = event.outcome === "error";
    const parts = [labelFor(functionPath, event), failed ? "error" : "ok", formatDuration(event.durationMs)];

    const read = asStringList(event.tablesRead);
    const written = asStringList(event.tablesWritten);

    if (read.length > 0) {
        parts.push(`read[${read.join(",")}]`);
    }

    if (written.length > 0) {
        parts.push(`write[${written.join(",")}]`);
    }

    if (event.cacheHit === true) {
        parts.push("cached");
    }

    const errorMessage = asString(event.error);

    if (failed && errorMessage !== "") {
        parts.push(errorMessage);
    }

    return { kind: "rpc", level: failed ? "error" : "info", text: parts.join("  ") };
};

/**
 * Format a `type: "container"` lifecycle event: `container:&lt;name>#&lt;short-id> &lt;event> &lt;detail>`.
 * The instance id is truncated to keep the line readable — it's a correlation
 * hint, not a value to copy. Errors surface on the `error` channel.
 */
const formatContainer = (event: LunoraEvent): LunoraFormattedLine => {
    const name = asString(event.container) || "<unknown>";
    const instance = asString(event.instance);
    const transition = asString(event.event) || "event";
    const shortId = instance === "" || instance === "unknown" ? "" : `#${instance.slice(0, 8)}`;
    const message = asString(event.message);

    const parts = [`container:${name}${shortId}`, transition];

    if (message !== "") {
        parts.push(message);
    }

    return { kind: "log", level: event.event === "error" ? "error" : "info", text: parts.join("  ") };
};

/**
 * Parse a single worker-output line and, when it is a lunora structured event,
 * return its severity plus display text. Returns `undefined` for anything else —
 * non-JSON lines, JSON that isn't a lunora event, or an unrecognised event type
 * — so the caller passes the original line through untouched. Pure and total.
 */
const formatLunoraEvent = (line: string): LunoraFormattedLine | undefined => {
    const event = parseLunoraEvent(line);

    if (!event) {
        return undefined;
    }

    const functionPath = asString(event.function) || "<unknown>";

    if (event.type === "log") {
        const parts = [`${labelFor(functionPath, event)}  ${asString(event.message)}`.trimEnd()];
        const fields = formatLogFields(event.fields);

        if (fields !== "") {
            parts.push(fields);
        }

        // A short trace-id suffix links the line to its RPC span without the noise
        // of the full 32-hex id.
        const traceId = asString(event.traceId);

        if (traceId !== "") {
            parts.push(`trace=${traceId.slice(0, 8)}`);
        }

        return { kind: "log", level: toLineLevel(asString(event.level)), text: parts.join("  ") };
    }

    if (event.type === "request") {
        return formatRequest(event, functionPath);
    }

    if (event.type === "container") {
        return formatContainer(event);
    }

    return undefined;
};

export { formatLunoraEvent, LUNORA_EVENT_SOURCE };
export type { LunoraFormattedLine, LunoraLineLevel };
