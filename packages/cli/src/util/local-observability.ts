/**
 * Read-only SQL over the spans and console logs the LOCAL dev runtime captured.
 *
 * `@cloudflare/vite-plugin` (1.54+) runs the worker in workerd inside the Vite
 * process and records every request span and console line into an in-memory
 * store, exposed at `POST /cdn-cgi/local/explorer/api/local/observability/query`
 * as read-only SQL. This module is the client for that endpoint.
 *
 * **Why this exists.** `lunora logs` could previously only reach a DEPLOYED
 * Worker — `wrangler tail` for the live stream, R2 SQL for the durable archive.
 * Both require a deploy. So the one place a developer spends most of their time,
 * the local dev loop, was the one place the command could not help: you had to
 * read raw worker output scrolling past in the Vite terminal, with no way to
 * filter it, scroll back, or pull one trace out of it. This closes that gap
 * against a dev server that is already running.
 *
 * Query building and row mapping are pure and unit-tested; `fetch` is injected so
 * the read path never touches the network in tests.
 */

/** The dev server's read-only observability endpoint (a `@cloudflare/vite-plugin` local API). */
const LOCAL_EXPLORER_QUERY_PATH = "/cdn-cgi/local/explorer/api/local/observability/query";

/** Where `lunora dev` serves by default. Overridable, because Vite walks the port up when 5173 is taken. */
const DEFAULT_DEV_SERVER_URL = "http://localhost:5173";

/** Rows one local read returns unless `--limit` says otherwise. */
const DEFAULT_LOCAL_LOG_LIMIT = 200;

/** Ceiling on rows one local read returns — the store is in-memory and bounded anyway. */
const MAX_LOCAL_LOG_LIMIT = 5000;

/**
 * Console channels the capture records.
 *
 * Deliberately NOT the framework's seven-tier `ctx.log` ramp: the store sees the
 * `console` method the runtime chose (`console.log`/`warn`/`error`), so `debug`,
 * `trace` and `fatal` are not distinguishable in SQL — they live inside the JSON
 * envelope in `message`. Filtering on what the table actually has beats accepting
 * a level that would silently match nothing.
 */
const LOCAL_LOG_LEVELS = new Set(["error", "info", "warn"]);

/** A bare epoch-millis value: all digits (anything else is parsed as a date string). */
const EPOCH_MILLIS_RE = /^\d+$/;

/** Escape a string for single-quoted SQL — the endpoint takes raw text, no bound params. */
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Parse a `--since` / `--until` bound into epoch millis, or `undefined` when the
 * input is not a time. Accepts bare epoch millis or anything `Date` parses.
 */
const parseTimeBound = (value: string | undefined): number | undefined => {
    if (value === undefined || value.trim() === "") {
        return undefined;
    }

    if (EPOCH_MILLIS_RE.test(value.trim())) {
        return Number(value.trim());
    }

    const parsed = Date.parse(value);

    return Number.isNaN(parsed) ? undefined : parsed;
};

/** Filters a local log read accepts — each maps to a column the capture actually has. */
interface LocalLogQuery {
    /** Console channel (`info` | `warn` | `error`). */
    level?: string;
    /** Max rows (clamped to `[1, MAX_LOCAL_LOG_LIMIT]`). */
    limit?: number;
    /** Substring match on the raw line. */
    search?: string;
    /** Lower time bound, epoch millis (inclusive). */
    sinceMs?: number;
    /** Trace-id filter — the whole of one request's output. */
    traceId?: string;
    /** Upper time bound, epoch millis (inclusive). */
    untilMs?: number;
}

/**
 * Build the SQL for a local log read: newest-first, bounded, with only the
 * filters the caller actually set.
 *
 * Ordered newest-first and reversed for display, so `--limit` keeps the MOST
 * RECENT n lines rather than the oldest n — a tail that dropped the newest
 * output would be useless.
 */
const buildLocalLogQuery = (query: LocalLogQuery = {}): string => {
    const where: string[] = [];

    if (query.level !== undefined && LOCAL_LOG_LEVELS.has(query.level)) {
        where.push(`level = ${quote(query.level)}`);
    }

    if (query.traceId !== undefined && query.traceId !== "") {
        where.push(`trace_id = ${quote(query.traceId)}`);
    }

    if (query.sinceMs !== undefined) {
        where.push(`ts_ms >= ${String(Math.floor(query.sinceMs))}`);
    }

    if (query.untilMs !== undefined) {
        where.push(`ts_ms <= ${String(Math.floor(query.untilMs))}`);
    }

    if (query.search !== undefined && query.search !== "") {
        // `instr` rather than `LIKE`: the needle is arbitrary user text, and `LIKE`
        // would treat `%` and `_` in it as wildcards.
        where.push(`instr(message, ${quote(query.search)}) > 0`);
    }

    const limit = Math.min(Math.max(Math.floor(query.limit ?? DEFAULT_LOCAL_LOG_LIMIT), 1), MAX_LOCAL_LOG_LIMIT);

    return [
        "SELECT trace_id, span_id, ts_ms, level, message",
        "FROM logs",
        where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
        "ORDER BY ts_ms DESC, seq DESC",
        `LIMIT ${String(limit)}`,
    ]
        .filter((part) => part !== "")
        .join(" ");
};

/** One captured console line. */
interface LocalLogLine {
    level: string;
    /** The line as the worker wrote it, already unwrapped by {@link unwrapConsoleMessage}. */
    message: string;
    spanId: string;
    traceId: string;
    tsMs: number;
}

/**
 * Recover the text a worker actually passed to `console.*` from the stored value.
 *
 * The capture stores `JSON.stringify` of the console ARGUMENTS, not the rendered
 * line: `console.log("jsrpc")` is stored as `"jsrpc"` — quotes included — and a
 * multi-argument call is stored as a JSON array. That matters more than it looks,
 * because `ctx.log` emits its structured event as `console.log(jsonString)`: left
 * wrapped, the envelope arrives double-encoded, `formatLunoraEvent` fails to
 * recognise it, and every `ctx.log` line prints as escaped JSON — exactly the
 * output this command exists to replace.
 *
 * Unwraps one level and no further: a JSON string becomes its contents, a JSON
 * array becomes its elements space-joined (how `console` renders them), and
 * anything that does not parse is returned untouched rather than guessed at.
 */
const unwrapConsoleMessage = (stored: string): string => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stored);
    } catch {
        // Not JSON at all — a runtime that logged a bare line. Use it as-is.
        return stored;
    }

    if (typeof parsed === "string") {
        return parsed;
    }

    if (Array.isArray(parsed)) {
        return parsed.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
    }

    return stored;
};

/** The endpoint's response envelope (Cloudflare's standard result shape). */
interface ExplorerResponse {
    errors?: { message?: string }[];
    result?: { columns?: string[]; rows?: unknown[][] };
    success?: boolean;
}

const asString = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }

    return value === null || value === undefined ? "" : JSON.stringify(value);
};

const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Map the endpoint's column/row pairs onto {@link LocalLogLine}s by COLUMN NAME.
 *
 * By name rather than by position: the response carries its own `columns` array,
 * and a future runtime that adds or reorders a column would otherwise shift every
 * field silently. Reversed to oldest-first, which is how a log tail reads.
 */
const mapLocalLogRows = (result: ExplorerResponse["result"]): LocalLogLine[] => {
    const columns = result?.columns ?? [];
    const index = (name: string): number => columns.indexOf(name);
    const at = (row: unknown[], name: string): unknown => {
        const position = index(name);

        return position === -1 ? undefined : row[position];
    };

    return (result?.rows ?? [])
        .map((row) => {
            return {
                level: asString(at(row, "level")),
                message: unwrapConsoleMessage(asString(at(row, "message"))),
                spanId: asString(at(row, "span_id")),
                traceId: asString(at(row, "trace_id")),
                tsMs: asNumber(at(row, "ts_ms")),
            };
        })
        .toReversed();
};

/** Raised when the dev server is unreachable or refuses the query, carrying an actionable message. */
class LocalObservabilityError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "LocalObservabilityError";
    }
}

interface LocalObservabilityOptions {
    /** Inject a `fetch` double (tests). */
    fetch?: typeof globalThis.fetch;
    /** Base URL of the running dev server. */
    url?: string;
}

/** Strip trailing slashes before joining the endpoint path onto the base URL. */
const stripTrailingSlashes = (value: string): string => {
    let result = value;

    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }

    return result;
};

/**
 * Run one read-only SQL query against a running dev server's capture.
 *
 * Every failure mode names the fix, because all of them are the same user
 * mistake in different clothes — the dev server is not running, or is on another
 * port, or is too old to expose the endpoint. A bare `ECONNREFUSED` would send
 * someone hunting through their app.
 */
const queryLocalObservability = async (sql: string, options: LocalObservabilityOptions = {}): Promise<ExplorerResponse["result"]> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const base = stripTrailingSlashes(options.url ?? DEFAULT_DEV_SERVER_URL);

    let response: Response;

    try {
        response = await fetchImpl(`${base}${LOCAL_EXPLORER_QUERY_PATH}`, {
            body: JSON.stringify({ sql }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });
    } catch (error) {
        throw new LocalObservabilityError(
            `cannot reach a dev server at ${base} (${error instanceof Error ? error.message : String(error)}). ` +
                "Start one with `lunora dev`, or point at it with `--url` if it picked another port.",
        );
    }

    if (response.status === 404) {
        throw new LocalObservabilityError(
            `${base} is serving, but has no local observability endpoint. ` +
                "It needs @cloudflare/vite-plugin 1.54 or newer — check that the dev server is a Lunora app and not another site on that port.",
        );
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => "");

        throw new LocalObservabilityError(`local observability query failed (${String(response.status)})${detail ? `: ${detail}` : ""}`);
    }

    const payload = (await response.json()) as ExplorerResponse;

    if (payload.success === false) {
        const detail = payload.errors
            ?.map((entry) => entry.message ?? "")
            .filter(Boolean)
            .join("; ");

        throw new LocalObservabilityError(`local observability query rejected${detail ? `: ${detail}` : ""}`);
    }

    return payload.result;
};

/** Read captured console lines from a running dev server, oldest-first. */
const readLocalLogs = async (query: LocalLogQuery, options: LocalObservabilityOptions = {}): Promise<LocalLogLine[]> =>
    mapLocalLogRows(await queryLocalObservability(buildLocalLogQuery(query), options));

export {
    buildLocalLogQuery,
    DEFAULT_DEV_SERVER_URL,
    DEFAULT_LOCAL_LOG_LIMIT,
    LOCAL_EXPLORER_QUERY_PATH,
    LOCAL_LOG_LEVELS,
    LocalObservabilityError,
    mapLocalLogRows,
    MAX_LOCAL_LOG_LIMIT,
    parseTimeBound,
    queryLocalObservability,
    readLocalLogs,
    unwrapConsoleMessage,
};
export type { LocalLogLine, LocalLogQuery, LocalObservabilityOptions };
