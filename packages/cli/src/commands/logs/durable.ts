/**
 * `lunora logs --durable` — read the durable `ctx.log` archive back.
 *
 * The live path (`handler.ts`) streams a deployed Worker's logs with `wrangler
 * tail`; this path reads the **persisted** archive that `pipelineLogSink` lands
 * in R2 (an Iceberg table in R2 Data Catalog) via R2 SQL. It builds the R2 SQL
 * client from env, runs `createPipelineLogReader`, and prints one page of rows as
 * a table (default) or NDJSON (`--ndjson`, cleanly pipeable to `jq`).
 *
 * Fail-closed: R2 SQL needs an account id, API token, bucket, and target table.
 * When any is missing we print an actionable message and exit non-zero rather
 * than issuing a half-configured request — the archive only exists once the
 * operator has wired the Pipeline → R2 Data Catalog table (see the docs).
 */
import { createR2Sql } from "@lunora/bindings/r2sql";
import type { PipelineLogCursor, PipelineLogQuery, PipelineLogRow } from "@lunora/runtime";
import { createPipelineLogReader } from "@lunora/runtime";

import { LOG_LEVEL_ORDER } from "../../../../../shared/log-event";
import type { Logger } from "../../util/logger";

/**
 * The severities the reader accepts, for `--level` / `--min-level` validation.
 *
 * Derived from `LOG_LEVEL_ORDER` rather than re-listed: the reader ranks
 * `--min-level` by that array's index, so a hand-kept copy here would let a
 * level pass validation and then rank `-1` (silently meaning "no floor").
 * Membership only — the ordering is the reader's concern.
 */
const LOG_LEVELS: ReadonlySet<string> = new Set<string>(LOG_LEVEL_ORDER);

/** A bare epoch-millis value: all digits (anything else is parsed as a date string). */
const EPOCH_MILLIS_RE = /^\d+$/;

/** The env vars that carry the R2 SQL credentials (documented in `@lunora/codegen`'s capabilities). */
interface DurableLogsEnvironment {
    R2_SQL_ACCOUNT_ID?: string;
    R2_SQL_BUCKET?: string;
    R2_SQL_TOKEN?: string;
}

interface DurableLogsCommandOptions {
    /** Resume after a previous page: the opaque `--cursor` token the prior page printed (a bare epoch-millis `ts` is also accepted). */
    cursor?: string;
    /** Inject env (tests); defaults to `process.env`. */
    environment?: DurableLogsEnvironment;
    /** Inject a `fetch` double (tests); forwarded to `createR2Sql`. */
    fetch?: typeof globalThis.fetch;
    /** Filter to function paths starting with this prefix (`LIKE 'prefix%'`). */
    functionPrefix?: string;
    /** Exact severity filter. */
    level?: string;
    /** Max rows to return (clamped to `[1, 10000]`; default 500). */
    limit?: string;
    logger: Logger;
    /** Severity floor (keeps this level and every more-severe one). */
    minLevel?: string;
    /** The Iceberg namespace (R2 Data Catalog database) the table lives in. */
    namespace?: string;
    /** Emit one JSON object per line instead of a table. */
    ndjson?: boolean;
    /** Shard-key filter. */
    shardKey?: string;
    /** Lower time bound (epoch-millis or an ISO 8601 date), inclusive. */
    since?: string;
    /** The Iceberg table the Pipeline writes log records to. */
    table?: string;
    /** Trace-id filter. */
    traceId?: string;
    /** Upper time bound (epoch-millis or an ISO 8601 date), inclusive. */
    until?: string;
    /** User-id filter. */
    userId?: string;
}

interface DurableLogsCommandResult {
    code: number;
    /** Set when the run aborted before querying (missing config / bad input). */
    error?: string;
    /** Rows returned on a successful run (also printed). Handy for tests. */
    rows?: PipelineLogRow[];
}

/** Parse a `--since`/`--until` value: a bare epoch-millis integer, or any `Date.parse`-able string. */
const parseTimestamp = (value: string | undefined, flag: string): number | undefined => {
    if (value === undefined) {
        return undefined;
    }

    const trimmed = value.trim();

    // A pure-digit string is epoch-millis; anything else goes through Date.parse
    // (ISO 8601 etc.). Reject the unparseable rather than silently sending NaN.
    if (EPOCH_MILLIS_RE.test(trimmed)) {
        return Number(trimmed);
    }

    const parsed = Date.parse(trimmed);

    if (Number.isNaN(parsed)) {
        throw new TypeError(`logs: invalid ${flag} "${value}" — pass epoch-millis or an ISO 8601 date`);
    }

    return parsed;
};

/** Serialize a keyset cursor to a compact, opaque `--cursor` token (base64url JSON) that round-trips its `seen` boundary hashes. */
const encodeCursor = (cursor: PipelineLogCursor): string => Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

/**
 * Parse a `--cursor` value back to a {@link PipelineLogCursor}. Accepts the opaque
 * base64url token minted by {@link encodeCursor} (which carries the `seen` boundary
 * hashes, so resuming pages neither drops nor duplicates rows) and, for
 * convenience, a bare epoch-millis integer (a `ts`-only cursor — still lossless via
 * the reader's inclusive resume, but without `seen` it may re-emit boundary ties).
 */
const parseCursor = (raw: string): PipelineLogCursor => {
    const trimmed = raw.trim();

    // Back-compat / hand-typed convenience: a bare epoch-millis is a `ts`-only cursor.
    if (EPOCH_MILLIS_RE.test(trimmed)) {
        return { ts: Number(trimmed) };
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8"));
    } catch {
        throw new TypeError(`logs: invalid --cursor "${raw}" — expected the token printed by the previous page (or a bare epoch-millis ts)`);
    }

    if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { ts?: unknown }).ts !== "number" ||
        !Number.isFinite((parsed as { ts: number }).ts)
    ) {
        throw new TypeError(`logs: invalid --cursor "${raw}" — expected the token printed by the previous page (or a bare epoch-millis ts)`);
    }

    const { ts } = parsed as { ts: number };
    const seenRaw = (parsed as { seen?: unknown }).seen;
    const seen = Array.isArray(seenRaw) ? seenRaw.filter((entry): entry is string => typeof entry === "string") : undefined;

    return seen !== undefined && seen.length > 0 ? { seen, ts } : { ts };
};

/** Validate a severity against the known level set, throwing an actionable error otherwise. */
const parseLevel = (value: string | undefined, flag: string): PipelineLogQuery["level"] => {
    if (value === undefined) {
        return undefined;
    }

    if (!LOG_LEVELS.has(value)) {
        throw new TypeError(`logs: invalid ${flag} "${value}" — expected one of trace, debug, log, info, warn, error, fatal`);
    }

    return value as PipelineLogQuery["level"];
};

/** Build the {@link PipelineLogQuery} from raw CLI option strings, validating each. */
const buildQuery = (options: DurableLogsCommandOptions): PipelineLogQuery => {
    const query: PipelineLogQuery = {};

    const sinceTs = parseTimestamp(options.since, "--since");

    if (sinceTs !== undefined) {
        query.sinceTs = sinceTs;
    }

    const untilTs = parseTimestamp(options.until, "--until");

    if (untilTs !== undefined) {
        query.untilTs = untilTs;
    }

    const level = parseLevel(options.level, "--level");

    if (level !== undefined) {
        query.level = level;
    }

    const minLevel = parseLevel(options.minLevel, "--min-level");

    if (minLevel !== undefined) {
        query.minLevel = minLevel;
    }

    if (options.functionPrefix !== undefined) {
        query.functionPathPrefix = options.functionPrefix;
    }

    if (options.traceId !== undefined) {
        query.traceId = options.traceId;
    }

    if (options.shardKey !== undefined) {
        query.shardKey = options.shardKey;
    }

    if (options.userId !== undefined) {
        query.userId = options.userId;
    }

    if (options.limit !== undefined) {
        const limit = Number(options.limit);

        if (!Number.isFinite(limit)) {
            throw new TypeError(`logs: invalid --limit "${options.limit}" — expected a number`);
        }

        query.limit = limit;
    }

    if (options.cursor !== undefined) {
        query.cursor = parseCursor(options.cursor);
    }

    return query;
};

/** Render one row as a single, aligned table line (ISO time · level · path · message). */
const formatRow = (row: PipelineLogRow): string => {
    const time = new Date(row.ts).toISOString();
    const level = row.level.toUpperCase().padEnd(5);

    return `${time}  ${level}  ${row.functionPath}  ${row.message}`;
};

/**
 * Read one page of durable logs and print it. Fails closed (exit 1, no query)
 * when the R2 SQL credentials or target table are not configured.
 */
const runDurableLogsCommand = async (options: DurableLogsCommandOptions): Promise<DurableLogsCommandResult> => {
    const environment = options.environment ?? process.env;
    const accountId = environment.R2_SQL_ACCOUNT_ID;
    const apiToken = environment.R2_SQL_TOKEN;
    const bucket = environment.R2_SQL_BUCKET;

    // Fail-closed: the durable archive only exists once the operator has wired a
    // Pipeline → R2 Data Catalog table and provided read credentials. Name every
    // missing piece so the fix is unambiguous.
    const missing: string[] = [];

    if (accountId === undefined || accountId.length === 0) {
        missing.push("R2_SQL_ACCOUNT_ID");
    }

    if (apiToken === undefined || apiToken.length === 0) {
        missing.push("R2_SQL_TOKEN");
    }

    if (bucket === undefined || bucket.length === 0) {
        missing.push("R2_SQL_BUCKET");
    }

    if (options.table === undefined || options.table.length === 0) {
        missing.push("--table");
    }

    if (missing.length > 0) {
        options.logger.error(
            `logs --durable: R2 SQL not configured (missing ${missing.join(", ")}). The Pipeline must write to an R2 Data Catalog (Iceberg) table, and you must supply R2_SQL_ACCOUNT_ID / R2_SQL_TOKEN / R2_SQL_BUCKET plus --table — see the observability docs.`,
        );

        return { code: 1, error: "not configured" };
    }

    let query: PipelineLogQuery;

    try {
        query = buildQuery(options);
    } catch (error: unknown) {
        options.logger.error(error instanceof Error ? error.message : String(error));

        return { code: 1, error: "invalid option" };
    }

    // Non-null: the guard above returned when any credential/table was missing.
    const client = createR2Sql({ accountId: accountId as string, apiToken: apiToken as string, bucket: bucket as string, fetch: options.fetch });
    const reader = createPipelineLogReader(client, { namespace: options.namespace, table: options.table as string });

    const page = await reader.query(query);

    for (const row of page.rows) {
        // Row payload goes to stdout (NDJSON stays pipeable to `jq`); status/hints
        // go through the logger.
        process.stdout.write(`${options.ndjson === true ? JSON.stringify(row) : formatRow(row)}\n`);
    }

    if (page.rows.length === 0) {
        options.logger.info("logs --durable: no matching log records");
    } else if (page.nextCursor !== undefined) {
        options.logger.info(`logs --durable: more rows available — pass --cursor ${encodeCursor(page.nextCursor)} for the next page`);
    }

    return { code: 0, rows: page.rows };
};

export { runDurableLogsCommand };
export type { DurableLogsCommandOptions, DurableLogsCommandResult, DurableLogsEnvironment };
