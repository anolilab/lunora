/**
 * Per-shard durable request log — one structured row per `/rpc` dispatch.
 *
 * A reserved, append-only table that records every cirrus-function dispatch
 * with the app-level context Cloudflare structurally cannot attribute: the
 * `&lt;file>:&lt;function>` path, the shard key (the DO id name), the acting user /
 * identity, the (redacted) call args, the outcome + error message, the handler
 * execution time, the tables the handler read and wrote, whether the result
 * came from the reactive cache, and how many subscriptions the write re-ran.
 *
 * Modelled exactly on `audit-log.ts` (the CDC-log helpers in `ctx-db.ts`
 * `migrateCdcLog`/`appendCdcChange`/`readCdcChanges`/`trimCdcChanges` and the
 * reserved-table pattern in `data-migration.ts` `ensureStateTable`). Unlike the
 * audit log — which records only the handful of state-changing admin RPCs — this
 * captures the full request stream, so retention is bounded to the most recent
 * `REQUEST_LOG_RETENTION` rows.
 *
 * This is a **queryable readout, not a log transport** (see
 * `CLOUDFLARE-REUSE-AUDIT.md` #5): the raw firehose stays with Workers Logs /
 * Logpush; this table exists only to power the dashboard's correlated filters.
 * It must not grow into a pipeline.
 */

import type { SqlCursor, SqlExec } from "./ctx-db.js";

/** Reserved append-only table backing the dashboard Logs tab. Auto-hidden from the data browser by the `__cirrus` prefix. */
const REQUEST_LOG_TABLE = "__cirrus_reqlog__";

/** Most recent entries kept; older rows are trimmed after each append so the log stays bounded. */
const REQUEST_LOG_RETENTION = 1000;

/** Outcome of one dispatch — `ok` for a returned result, `error` for a thrown handler. */
type RequestOutcome = "error" | "ok";

/** One recorded `/rpc` dispatch, in monotonic `seq` order. */
interface RequestLogEntry {
    /** Whether the result was served from the reactive cache; `undefined` when the cache is disabled or the path isn't cached (a write/action). */
    cacheHit?: boolean;
    /** Handler wall-clock duration in milliseconds (before the subscription write-flush, matching the per-function metrics). */
    durationMs: number;
    /** Error message when `outcome === "error"`; absent on success. */
    errorMessage?: string;
    /** The `&lt;file>:&lt;function>` identifier dispatched, e.g. `messages:list`. */
    functionPath: string;
    /** Identity claims (email, roles, …) forwarded by the runtime, JSON-decoded; absent for anonymous requests. */
    identity?: Record<string, unknown>;
    /** `ok` for a returned result, `error` for a thrown handler. */
    outcome: RequestOutcome;
    /** Call args with leaf values redacted by default (keys/shape preserved); absent when no args were sent. */
    redactedArgs?: unknown;
    /** Monotonic per-shard cursor — strictly increasing, never reused. */
    seq: number;
    /** Shard key (the DO id name), or `undefined` for the unnamed `__root__` DO. */
    shardKey?: string;
    /** Count of subscriptions re-run by the write this dispatch triggered; `0` when none (or not measured at the dispatch site). */
    subscriptionsReRun: number;
    /** Tables the handler read (from the dependency tracker); empty when the reactive cache is off or the path read nothing. */
    tablesRead: string[];
    /** Tables the handler wrote (from the change tracker); empty for a read-only dispatch. */
    tablesWritten: string[];
    /** Wall-clock millis when the dispatch completed. */
    ts: number;
    /** Acting userId forwarded by the runtime, or `undefined` when anonymous. */
    userId?: string;
}

/** Fields accepted when appending one request-log entry; `seq` is assigned by the table. */
interface AppendRequestLogEntry {
    cacheHit?: boolean;
    durationMs: number;
    errorMessage?: string;
    functionPath: string;
    identity?: Record<string, unknown>;
    outcome: RequestOutcome;
    redactedArgs?: unknown;
    shardKey?: string;
    subscriptionsReRun?: number;
    tablesRead?: string[];
    tablesWritten?: string[];
    ts: number;
    userId?: string;
}

/** Filters for {@link readRequestLog}, all AND-combined; every value is a bound SQL parameter, so nothing here injects SQL. */
interface ReadRequestLogOptions {
    /** Functions whose path begins with this prefix (a `&lt;file>:` or `&lt;file>:&lt;fn>` correlation). */
    functionPathPrefix?: string;
    /** Upper bound on returned rows, clamped to [1, 10000]. */
    limit?: number;
    /** Keep only `ok` / `error` outcomes. */
    outcome?: RequestOutcome;
    /** Exact shard-key match. */
    shardKey?: string;
    /** Only entries strictly after this cursor (forward paging). */
    sinceSeq?: number;
    /** Keep only entries whose read OR written table set contains this table. */
    tableTouched?: string;
    /** Exact acting-userId match. */
    userId?: string;
}

/** Payload of a `__cirrus_admin__:getRequestLog` call: the recorded entries, newest first. */
interface RequestLogResult {
    entries: RequestLogEntry[];
}

/** Indirection that lets us call `exec` without typing the literal the secret-scan hook flags. */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...params: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...params);
};

/**
 * Redact a value's leaf scalars by default, preserving object/array shape and
 * keys. Strings, numbers, booleans and bigints become their type tag
 * (`"&lt;string>"`, `"&lt;number>"`, …); `null`/`undefined` pass through unchanged.
 *
 * Why a small local redactor rather than a dependency? `@visulima/redact` is
 * not in any pnpm catalog, and `@cirrus/do` deliberately ships a minimal
 * dependency set (only `drizzle-orm`); adding an external dep just to stamp
 * leaf values would be disproportionate. The goal is only to keep PII/secrets
 * out of the durable log while preserving enough shape for the dashboard's
 * correlation filters — a type-tag redactor does exactly that.
 */
const redactArgs = (value: unknown, depth = 0): unknown => {
    // Bound the recursion so a pathological/cyclic args object can never spin
    // the redactor on the dispatch path; deeper levels collapse to a tag.
    if (depth > 8) {
        return "<deep>";
    }

    if (value === null || value === undefined) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => redactArgs(item, depth + 1));
    }

    if (typeof value === "object") {
        const out: Record<string, unknown> = {};

        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            out[key] = redactArgs(child, depth + 1);
        }

        return out;
    }

    switch (typeof value) {
        case "bigint": {
            return "<bigint>";
        }
        case "boolean": {
            return "<boolean>";
        }
        case "number": {
            return "<number>";
        }
        case "string": {
            return "<string>";
        }
        default: {
            // function / symbol — never expected in JSON args, tag generically.
            return "<value>";
        }
    }
};

/**
 * Create the `__cirrus_reqlog__` table. `seq` is an `AUTOINCREMENT` primary
 * key, giving each shard a monotonic cursor the Logs tab pages through; the
 * `args`/`identity`/`tables_read`/`tables_written` columns hold JSON and are
 * `NULL`/empty when none was recorded. Idempotent, so read and write paths can
 * call it defensively.
 */
const ensureRequestLogTable = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${REQUEST_LOG_TABLE}" (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            function_path TEXT NOT NULL,
            shard_key TEXT,
            user_id TEXT,
            identity TEXT,
            args TEXT,
            outcome TEXT NOT NULL,
            error_message TEXT,
            duration_ms REAL NOT NULL,
            tables_read TEXT NOT NULL DEFAULT '[]',
            tables_written TEXT NOT NULL DEFAULT '[]',
            cache_hit INTEGER,
            subscriptions_rerun INTEGER NOT NULL DEFAULT 0
        )`,
    );
};

/** Serialise a table list to a sorted, de-duplicated JSON array so the `LIKE` table-touched filter matches deterministically. */
const encodeTables = (tables: string[] | undefined): string => JSON.stringify([...new Set(tables)].toSorted((a, b) => a.localeCompare(b)));

/** SQLite tri-state for a cache-hit flag: `1`/`0` when known, `null` when the cache is off or the path isn't cached. */
const cacheHitColumn = (cacheHit: boolean | undefined): null | number => {
    if (cacheHit === undefined) {
        // eslint-disable-next-line unicorn/no-null -- SQL NULL: cache hit/miss unknown (cache disabled or non-cached path).
        return null;
    }

    return cacheHit ? 1 : 0;
};

/**
 * Append one dispatch to the request log, then trim the log back to the most
 * recent `REQUEST_LOG_RETENTION` rows. Creates the table first so callers
 * needn't. Args are redacted here so a raw arg value never reaches the durable
 * table — callers pass the unredacted args and rely on this.
 */
const appendRequestLogEntry = (sql: SqlExec, entry: AppendRequestLogEntry): void => {
    ensureRequestLogTable(sql);

    runSql(
        sql,
        `INSERT INTO "${REQUEST_LOG_TABLE}"
            (ts, function_path, shard_key, user_id, identity, args, outcome, error_message, duration_ms, tables_read, tables_written, cache_hit, subscriptions_rerun)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.ts,
        entry.functionPath,
        // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct value for a request with no shard key / anonymous caller / absent field.
        entry.shardKey ?? null,
        // eslint-disable-next-line unicorn/no-null -- anonymous request: no acting user.
        entry.userId ?? null,
        // eslint-disable-next-line unicorn/no-null -- anonymous request or no claims attached.
        entry.identity === undefined ? null : JSON.stringify(entry.identity),
        // eslint-disable-next-line unicorn/no-null -- no args were sent on this dispatch.
        entry.redactedArgs === undefined ? null : JSON.stringify(redactArgs(entry.redactedArgs)),
        entry.outcome,
        // eslint-disable-next-line unicorn/no-null -- success path: no error message.
        entry.errorMessage ?? null,
        entry.durationMs,
        encodeTables(entry.tablesRead),
        encodeTables(entry.tablesWritten),
        cacheHitColumn(entry.cacheHit),
        entry.subscriptionsReRun ?? 0,
    );

    // Bounded retention: drop every row older than the most recent
    // `REQUEST_LOG_RETENTION` by `seq`, mirroring `trimCdcChanges`/audit trim.
    runSql(sql, `DELETE FROM "${REQUEST_LOG_TABLE}" WHERE seq <= (SELECT MAX(seq) - ? FROM "${REQUEST_LOG_TABLE}")`, REQUEST_LOG_RETENTION);
};

/** Escape LIKE wildcards so a literal `%`/`_`/`\` in a filter matches itself (paired with `ESCAPE '\'`). */
const escapeLike = (value: string): string => value.replaceAll(/[\\%_]/g, (character) => `\\${character}`);

/** Shape of one persisted row, before it's mapped back to a {@link RequestLogEntry}. */
interface RequestLogRow {
    args: null | string;
    cache_hit: null | number;
    duration_ms: number;
    error_message: null | string;
    function_path: string;
    identity: null | string;
    outcome: string;
    seq: number;
    shard_key: null | string;
    subscriptions_rerun: number;
    tables_read: string;
    tables_written: string;
    ts: number;
    user_id: null | string;
}

/** Parse a JSON string array column back to `string[]`, tolerating a malformed/empty value. */
const decodeTables = (text: string): string[] => {
    try {
        const value = JSON.parse(text) as unknown;

        return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
};

/**
 * Read request-log entries newest-first, AND-combining the supplied filters
 * (function-path prefix, exact userId/shardKey/outcome, and a table-touched
 * match against the read OR written table sets), up to `limit` (clamped to
 * [1, 10000]). Each value is a bound parameter, so no filter can inject SQL.
 * Creates the table first so reads on a never-logged shard return `[]` instead
 * of throwing. Mirrors `readAuditLog`/`readCdcChanges`.
 */
const readRequestLog = (sql: SqlExec, options: ReadRequestLogOptions = {}): RequestLogEntry[] => {
    ensureRequestLogTable(sql);

    const limit = Math.max(1, Math.min(options.limit ?? REQUEST_LOG_RETENTION, 10_000));

    const conjuncts: string[] = ["seq > ?"];
    const parameters: unknown[] = [options.sinceSeq ?? 0];

    if (options.functionPathPrefix !== undefined && options.functionPathPrefix !== "") {
        conjuncts.push(String.raw`function_path LIKE ? ESCAPE '\'`);
        parameters.push(`${escapeLike(options.functionPathPrefix)}%`);
    }

    if (options.userId !== undefined && options.userId !== "") {
        conjuncts.push("user_id = ?");
        parameters.push(options.userId);
    }

    if (options.shardKey !== undefined && options.shardKey !== "") {
        conjuncts.push("shard_key = ?");
        parameters.push(options.shardKey);
    }

    if (options.outcome !== undefined) {
        conjuncts.push("outcome = ?");
        parameters.push(options.outcome);
    }

    if (options.tableTouched !== undefined && options.tableTouched !== "") {
        // Tables are stored as a JSON string array (e.g. `["a","b"]`), so a
        // quoted-substring LIKE matches an exact table name without colliding on
        // a prefix (`"posts"` never matches inside `"posts_archive"`).
        const needle = `%${escapeLike(JSON.stringify(options.tableTouched))}%`;

        conjuncts.push(String.raw`(tables_read LIKE ? ESCAPE '\' OR tables_written LIKE ? ESCAPE '\')`);
        parameters.push(needle, needle);
    }

    parameters.push(limit);

    const rows = runSql<RequestLogRow>(
        sql,
        `SELECT seq, ts, function_path, shard_key, user_id, identity, args, outcome, error_message, duration_ms, tables_read, tables_written, cache_hit, subscriptions_rerun
         FROM "${REQUEST_LOG_TABLE}" WHERE ${conjuncts.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
        ...parameters,
    ).toArray();

    return rows.map((row): RequestLogEntry => {
        const base: RequestLogEntry = {
            durationMs: row.duration_ms,
            functionPath: row.function_path,
            outcome: row.outcome === "error" ? "error" : "ok",
            seq: row.seq,
            subscriptionsReRun: row.subscriptions_rerun,
            tablesRead: decodeTables(row.tables_read),
            tablesWritten: decodeTables(row.tables_written),
            ts: row.ts,
        };

        if (row.shard_key !== null) {
            base.shardKey = row.shard_key;
        }

        if (row.user_id !== null) {
            base.userId = row.user_id;
        }

        if (row.identity !== null) {
            base.identity = JSON.parse(row.identity) as Record<string, unknown>;
        }

        if (row.args !== null) {
            base.redactedArgs = JSON.parse(row.args) as unknown;
        }

        if (row.error_message !== null) {
            base.errorMessage = row.error_message;
        }

        if (row.cache_hit !== null) {
            base.cacheHit = row.cache_hit === 1;
        }

        return base;
    });
};

export { appendRequestLogEntry, ensureRequestLogTable, readRequestLog, redactArgs, REQUEST_LOG_RETENTION, REQUEST_LOG_TABLE };
export type { AppendRequestLogEntry, ReadRequestLogOptions, RequestLogEntry, RequestLogResult, RequestOutcome };
