/**
 * Shared formatter for the structured log events the Cirrus runtime emits to the
 * worker's `console` during development. Both the CLI `dev` command and the Vite
 * plugin pipe worker output through `formatCirrusEvent` so a developer sees
 * attributed, readable lines instead of raw JSON.
 *
 * The runtime emits two event shapes, each a single `console` line tagged
 * `source: "cirrus"` (see `@cirrus/do`'s `request-log.ts`): a `type: "log"`
 * event per `ctx.log.*` call, and a `type: "request"` event per RPC dispatch
 * (opt-in for successful calls, always for errors).
 *
 * This module is intentionally dependency-free and colour-free: it returns the
 * severity plus a plain display string, leaving ANSI/level colouring to each
 * caller (the CLI routes through its `pail` logger; the Vite plugin dims inline).
 * Any line that is not a cirrus event returns `undefined`, signalling the caller
 * to pass it through unchanged.
 */

/** Severity a formatted line should be surfaced at, mapped onto the three logger channels. */
type CirrusLineLevel = "error" | "info" | "warn";

/** A formatted cirrus event: the channel to surface it on, the display text, and which event produced it. */
interface CirrusFormattedLine {
    /** `"log"` for a `ctx.log.*` line, `"rpc"` for a dispatch summary. */
    kind: "log" | "rpc";
    /** Logger channel — callers colour by this. */
    level: CirrusLineLevel;
    /** Human-readable, colour-free line content (no `[cirrus]` tag — callers add their own). */
    text: string;
}

/** Stable `source` tag every cirrus console event carries. Mirrors `REQUEST_LOG_EVENT_SOURCE` in `@cirrus/do`. */
const CIRRUS_EVENT_SOURCE = "cirrus";

/** Raw shape of a parsed cirrus event line; fields are validated before use. */
interface CirrusEvent {
    cacheHit?: unknown;
    durationMs?: unknown;
    error?: unknown;
    function?: unknown;
    level?: unknown;
    message?: unknown;
    outcome?: unknown;
    shard?: unknown;
    source?: unknown;
    tablesRead?: unknown;
    tablesWritten?: unknown;
    type?: unknown;
}

/** Coerce an unknown to a string, or `""` when it isn't a string. */
const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Coerce an unknown table list to `string[]`, dropping non-string members. */
const asStringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** Render a duration as a compact `Nms` (integer millis); `?ms` when the value is missing/non-numeric. */
const formatDuration = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? `${String(Math.round(value))}ms` : "?ms");

/** Map a raw `ctx.log` level string onto one of the three logger channels. */
const toLineLevel = (rawLevel: string): CirrusLineLevel => {
    if (rawLevel === "error") {
        return "error";
    }

    if (rawLevel === "warn") {
        return "warn";
    }

    return "info";
};

/** Parse a worker-output line into a cirrus event, or `undefined` when it isn't one. Never throws. */
const parseCirrusEvent = (line: string): CirrusEvent | undefined => {
    const trimmed = line.trim();

    // Fast reject: every cirrus event is a single JSON object literal.
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

    const event: CirrusEvent = parsed;

    return event.source === CIRRUS_EVENT_SOURCE ? event : undefined;
};

/** Attribution label: `function@shard` when a shard key is present, else the bare function path. */
const labelFor = (functionPath: string, event: CirrusEvent): string => {
    const shard = asString(event.shard);

    return shard === "" ? functionPath : `${functionPath}@${shard}`;
};

/** Format a `type: "request"` dispatch summary. */
const formatRequest = (event: CirrusEvent, functionPath: string): CirrusFormattedLine => {
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
 * Parse a single worker-output line and, when it is a cirrus structured event,
 * return its severity plus display text. Returns `undefined` for anything else —
 * non-JSON lines, JSON that isn't a cirrus event, or an unrecognised event type
 * — so the caller passes the original line through untouched. Pure and total.
 */
const formatCirrusEvent = (line: string): CirrusFormattedLine | undefined => {
    const event = parseCirrusEvent(line);

    if (!event) {
        return undefined;
    }

    const functionPath = asString(event.function) || "<unknown>";

    if (event.type === "log") {
        return { kind: "log", level: toLineLevel(asString(event.level)), text: `${labelFor(functionPath, event)}  ${asString(event.message)}`.trimEnd() };
    }

    if (event.type === "request") {
        return formatRequest(event, functionPath);
    }

    return undefined;
};

export { CIRRUS_EVENT_SOURCE, formatCirrusEvent };
export type { CirrusFormattedLine, CirrusLineLevel };
