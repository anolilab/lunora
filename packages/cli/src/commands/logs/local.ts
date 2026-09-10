/**
 * `lunora logs --local` — read the logs your RUNNING dev server captured.
 *
 * The other two paths both require a deploy: `handler.ts` streams a live Worker
 * with `wrangler tail`, and `durable.ts` reads the R2 archive. This one queries
 * the local dev runtime's own capture over the read-only SQL endpoint
 * `@cloudflare/vite-plugin` exposes, so the inner loop finally has a log reader
 * with filters, scrollback and trace lookup instead of raw output scrolling past
 * in the Vite terminal.
 *
 * Lines are pretty-printed through `formatLunoraEvent` — the SAME formatter the
 * Vite plugin and `lunora dev` use — so a `ctx.log` call reads identically here
 * and there, and the JSON envelope never leaks into the terminal. Anything that
 * is not a Lunora event (a bare `console.log` from your own code, a runtime
 * line) passes through verbatim, which is the formatter's documented contract.
 */
import { formatLunoraEvent } from "@lunora/config";

import type { LocalLogLine, LocalLogQuery } from "../../util/local-observability";
import { DEFAULT_DEV_SERVER_URL, LOCAL_LOG_LEVELS, LocalObservabilityError, parseTimeBound, readLocalLogs } from "../../util/local-observability";
import type { Logger } from "../../util/logger";

interface LocalLogsCommandOptions {
    /** Inject a `fetch` double (tests). */
    fetch?: typeof globalThis.fetch;
    /** Console channel filter (`info` | `warn` | `error`). */
    level?: string;
    /** Max lines to read. */
    limit?: string;
    logger: Logger;
    /** Emit one JSON object per line instead of formatted text. */
    ndjson?: boolean;
    /** Substring match on the raw line. */
    search?: string;
    /** Lower time bound (epoch-millis or ISO 8601). */
    since?: string;
    /** Trace-id filter — one request's whole output. */
    traceId?: string;
    /** Upper time bound (epoch-millis or ISO 8601). */
    until?: string;
    /** Dev-server base URL; defaults to {@link DEFAULT_DEV_SERVER_URL}. */
    url?: string;
}

interface LocalLogsCommandResult {
    code: number;
    /** Lines printed, so a caller (and the tests) can assert without parsing stdout. */
    lines: number;
}

/** Render one captured line's timestamp as a local wall-clock time. */
const formatTime = (tsMs: number): string => new Date(tsMs).toISOString().slice(11, 23);

/**
 * Print one line through the shared formatter, routed to the logger channel the
 * event's own severity asks for — so an error line is red here for the same
 * reason it is red in `lunora dev`.
 */
const printLine = (logger: Logger, line: LocalLogLine): void => {
    const formatted = formatLunoraEvent(line.message);
    const time = formatTime(line.tsMs);

    if (!formatted) {
        // Not a Lunora event — a bare `console.log`, or runtime output. Pass it
        // through verbatim rather than guessing at its shape.
        logger.info(`${time}  ${line.message}`);

        return;
    }

    const text = `${time}  ${formatted.text}`;

    if (formatted.level === "error") {
        logger.error(text);
    } else if (formatted.level === "warn") {
        logger.warn(text);
    } else {
        logger.info(text);
    }
};

/** The console channels, pre-sorted for the `--level` error message. */
const LEVEL_CHOICES = [...LOCAL_LOG_LEVELS].toSorted((a, b) => a.localeCompare(b)).join(", ");

/**
 * Validate the flags, returning the first problem as a ready-to-print message.
 *
 * Every case here rejects rather than ignores. A dropped `--since yesterday`
 * would return the whole buffer and look exactly like a filter that matched
 * everything, which is the worst way to be wrong about a log query.
 */
const validate = (options: LocalLogsCommandOptions): string | undefined => {
    if (options.level !== undefined && !LOCAL_LOG_LEVELS.has(options.level)) {
        return `logs --local: unknown --level "${options.level}". The local capture records the console channel, so it is one of: ${LEVEL_CHOICES}.`;
    }

    if (options.limit !== undefined) {
        const limit = Number(options.limit);

        if (!Number.isFinite(limit) || limit <= 0) {
            return `logs --local: --limit must be a positive number, got "${options.limit}"`;
        }
    }

    for (const [flag, raw] of [
        ["--since", options.since],
        ["--until", options.until],
    ] as const) {
        if (raw !== undefined && parseTimeBound(raw) === undefined) {
            return `logs --local: ${flag} "${raw}" is neither epoch-millis nor a date this runtime can parse`;
        }
    }

    return undefined;
};

/** Build the read filters, including only the flags the caller actually set. */
const toQuery = (options: LocalLogsCommandOptions): LocalLogQuery => {
    const sinceMs = parseTimeBound(options.since);
    const untilMs = parseTimeBound(options.until);

    return {
        ...(options.level === undefined ? {} : { level: options.level }),
        ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
        ...(options.search === undefined ? {} : { search: options.search }),
        ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
        ...(sinceMs === undefined ? {} : { sinceMs }),
        ...(untilMs === undefined ? {} : { untilMs }),
    };
};

/** `lunora logs --local` — testable body over an injected `fetch`. */
const runLocalLogsCommand = async (options: LocalLogsCommandOptions): Promise<LocalLogsCommandResult> => {
    const { logger } = options;
    const invalid = validate(options);

    if (invalid !== undefined) {
        logger.error(invalid);

        return { code: 1, lines: 0 };
    }

    let lines: LocalLogLine[];

    try {
        lines = await readLocalLogs(toQuery(options), {
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.url === undefined ? {} : { url: options.url }),
        });
    } catch (error) {
        // A `LocalObservabilityError` already names the fix; anything else gets the
        // command prefix so it is obvious which of the three sources failed.
        if (error instanceof LocalObservabilityError) {
            logger.error(error.message);
        } else {
            logger.error(`logs --local: ${error instanceof Error ? error.message : String(error)}`);
        }

        return { code: 1, lines: 0 };
    }

    if (lines.length === 0) {
        logger.info(
            `No captured lines at ${options.url ?? DEFAULT_DEV_SERVER_URL}. The capture starts when the dev server does and holds what it has seen since — exercise your app, then read again.`,
        );

        return { code: 0, lines: 0 };
    }

    if (options.ndjson === true) {
        for (const line of lines) {
            logger.info(JSON.stringify(line));
        }

        return { code: 0, lines: lines.length };
    }

    for (const line of lines) {
        printLine(logger, line);
    }

    return { code: 0, lines: lines.length };
};

export { runLocalLogsCommand };
export type { LocalLogsCommandOptions, LocalLogsCommandResult };
