/**
 * Per-shard durable request log — one structured row per `/rpc` dispatch.
 *
 * A reserved, append-only table that records every lunora-function dispatch
 * with the app-level context Cloudflare structurally cannot attribute: the
 * `<file>:<function>` path, the shard key (the DO id name), the acting user /
 * identity, the (redacted) call args, the outcome + (redacted) error message,
 * the handler execution time, the tables the handler read and wrote, whether
 * the result came from the reactive cache, and how many subscriptions the
 * write re-ran. The error-grouping fingerprint hash is captured from the RAW
 * message at write time (before redaction) and stored alongside the row, so
 * masking PII in the message can't change which Issue a row groups into — see
 * {@link appendRequestLogEntry} and {@link readErrorIssues}.
 *
 * Each row also carries the dispatch's `trace_id`. Note the deliberate
 * retention asymmetry: this table is DURABLE and bounded by row count, while
 * the `ctx.trace` span ring it correlates to is in-memory and resets on
 * hibernation. A trace id on a row older than the current DO instance therefore
 * resolves in an external collector but NOT against the local waterfall, and
 * the Studio treats a local miss as ordinary rather than as an error. Recording
 * it is still worth it: the id is what joins this row to the collector's spans
 * and to the `Logpush`-shipped console event, which is where a deployed app's
 * traces actually live.
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
 * Logpush; this table exists only to power the studio's correlated filters.
 * It must not grow into a pipeline.
 */

import { fingerprintError } from "@lunora/fingerprint";
import type { SqlExec } from "@lunora/shard-engine";
import { redact, standardRules } from "@visulima/redact";

import type { LogEvent } from "../../../shared/log-event";
import type { LogFields } from "../../../shared/log-fields";
import { normalizeLogFields } from "../../../shared/log-fields";
import type { IssueSeverity, IssueStatus } from "./issue-state";
import { readIssueStates } from "./issue-state";
import { runSql } from "./run-sql";

/** Reserved append-only table backing the studio Logs tab. Auto-hidden from the data browser by the `__lunora` prefix. */
const REQUEST_LOG_TABLE = "__lunora_reqlog__";

/** Most recent entries kept; older rows are trimmed after each append so the log stays bounded. */
const REQUEST_LOG_RETENTION = 1000;

/** Stable tag on every console-emitted event so a Logpush/SIEM consumer can filter lunora request events out of the raw Workers-trace firehose. */
const REQUEST_LOG_EVENT_SOURCE = "lunora";

/**
 * Columns added after the table's first release, as `<name> <type>` — each one
 * `ALTER`ed in on its own so a shard created before it gains it on the next
 * {@link ensureRequestLogTable}. A new column is one entry here plus the matching
 * line in the `CREATE`; nothing else needs a migration.
 */
const ADDED_COLUMNS = ["error_fingerprint TEXT", "trace_id TEXT"];

/** Outcome of one dispatch — `ok` for a returned result, `error` for a thrown handler. */
type RequestOutcome = "error" | "ok";

/** One recorded `/rpc` dispatch, in monotonic `seq` order. */
interface RequestLogEntry {
    /** Whether the result was served from the reactive cache; `undefined` when the cache is disabled or the path isn't cached (a write/action). */
    cacheHit?: boolean;
    /** Handler wall-clock duration in milliseconds (before the subscription write-flush, matching the per-function metrics). */
    durationMs: number;
    /** Error message when `outcome === "error"`, redacted like args/identity; absent on success. */
    errorMessage?: string;
    /** The `<file>:<function>` identifier dispatched, e.g. `messages:list`. */
    functionPath: string;
    /** Identity-claim envelope forwarded by the runtime, JSON-decoded; leaf values are redacted (the claims are PII), so only the shape survives. Absent for anonymous requests. Correlate on `userId` instead. */
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

    /** W3C trace id (32-hex) of the dispatch; `undefined` on a row appended before this column existed. See the module docstring on the retention asymmetry. */
    traceId?: string;
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
    traceId?: string;
    ts: number;
    userId?: string;
}

/** Knobs the dispatch site threads into a request-log write. */
interface RequestLogWriteOptions {
    /** When `true` (development only), skip args/identity redaction so a developer sees raw values. Defaults to `false` (production-safe). */
    captureRaw?: boolean;
    /** Rows to keep after the append-time trim; defaults to {@link REQUEST_LOG_RETENTION}. The operator's `LUNORA_REQUEST_LOG_RETENTION` override. */
    retention?: number;
}

/** Filters for {@link readRequestLog}, all AND-combined; every value is a bound SQL parameter, so nothing here injects SQL. */
interface ReadRequestLogOptions {
    /** Functions whose path begins with this prefix (a `<file>:` or `<file>:<fn>` correlation). */
    functionPathPrefix?: string;
    /** Upper bound on returned rows, clamped to [1, 10000]. */
    limit?: number;
    /** Keep only `ok` / `error` outcomes. */
    outcome?: RequestOutcome;
    /** Exact shard-key match. */
    shardKey?: string;

    /**
     * Only entries strictly after this cursor. Setting it switches the read to
     * ASCENDING order — see {@link readRequestLog} — because that is the only
     * ordering under which advancing the cursor to the last returned `seq`
     * actually pages forward without a hole.
     */
    sinceSeq?: number;
    /** Keep only entries whose read OR written table set contains this table. */
    tableTouched?: string;
    /** Exact acting-userId match. */
    userId?: string;
}

/** Payload of a `__lunora_admin__:getRequestLog` call: the recorded entries, newest first — or oldest first when the request paged forward with `sinceSeq` (see {@link readRequestLog}). */
interface RequestLogResult {
    entries: RequestLogEntry[];
}

/**
 * One grouped error **Issue**: many `error`-outcome request-log rows that share a
 * fingerprint folded into a single triage row. The `hash` is the same stable key
 * a cloud Incident groups on, so a local Issue and a cloud Incident are the same
 * object.
 */
interface ErrorIssue {
    /** Assignee (a userId or a name) from the persisted triage state; absent when unassigned. */
    assignee?: string;
    /** Number of `error` rows folded into this Issue within the scanned window. */
    count: number;
    /** The `<file>:<function>` (or `container:<name>`) the errors came from. */
    culprit: string;
    /** Wall-clock millis of the oldest folded row. */
    firstSeen: number;

    /**
     * Stable 16-char grouping hash over `functionPath :: bucket(message)`,
     * computed from the RAW (pre-redaction) message at write time and stored on
     * the row — see {@link appendRequestLogEntry} — so redacting `sampleMessage`
     * below can't change the grouping.
     */
    hash: string;
    /** Wall-clock millis of the newest folded row. */
    lastSeen: number;
    /** A representative error message (redacted, like the durable row) — taken from the most recent folded row. */
    sampleMessage: string;
    /** Developer-tagged severity from the persisted triage state; absent when untriaged. */
    severity?: IssueSeverity;

    /**
     * Wall-clock millis the persisted triage state was last changed; absent when
     * the Issue has never been triaged. Compared against `lastSeen` to detect a
     * regression (a new error after a resolve).
     */
    stateUpdatedAt?: number;

    /**
     * Triage status folded in from the persisted state (`open` by default). A
     * `resolved` Issue whose `lastSeen` is newer than `stateUpdatedAt` is
     * auto-reopened to `open` here (a regression), so a fresh occurrence never
     * hides behind a stale resolution; `ignored` stays sticky by design.
     */
    status: IssueStatus;
    /** Human-readable title (first line of the sample message, capped). */
    title: string;
}

/** Payload of a `__lunora_admin__:getIssues` call: grouped error Issues, most-recently-active first. */
interface IssuesResult {
    issues: ErrorIssue[];
}

/** Filters for {@link readErrorIssues}; forwarded to {@link readRequestLog} with `outcome` forced to `error`. */
interface ReadIssuesOptions {
    /** Functions whose path begins with this prefix (a `<file>:` or `<file>:<fn>` correlation). */
    functionPathPrefix?: string;
    /** Upper bound on error rows scanned before grouping, clamped to [1, 10000]. */
    limit?: number;
    /** Exact shard-key match. */
    shardKey?: string;
    /** Keep only Issues in this triage status, applied AFTER the persisted-state fold + auto-reopen. */
    status?: IssueStatus;
    /** Exact acting-userId match. */
    userId?: string;
}

/**
 * Redact the secrets / PII out of a value before it reaches the durable log or a
 * Logpush event, via `@visulima/redact`'s `standardRules`. Unlike a blunt
 * type-tag stamp this masks sensitive values by PATTERN (not just by key name)
 * while leaving benign values readable, so the studio's args/identity columns
 * stay useful. `null` / `undefined` pass through unchanged.
 *
 * What `standardRules` actually catches differs by shape, verified against its
 * real behavior rather than assumed from its name: on a KEYED object (`args`,
 * `identity`) it also matches by key name, so `{ password: "hunter2" }` and
 * `{ token: "…" }` ARE masked regardless of the value's shape. On a PLAIN
 * STRING — which is what `errorMessage`/log `fields`-as-rendered-text are —
 * only pattern-shaped matches apply: emails, long digit runs / structured
 * numeric IDs (credit-card, phone, SSN, AWS-access-key-style), and an explicit
 * `Bearer <token>` / `token=…`-shaped substring. A free-text `password=hunter2`
 * or a bare provider API key embedded in prose (e.g. `sk-live-…`) is NOT
 * caught on a plain string — there is no key to match against, and neither is
 * a recognized value pattern. So this is a PII-pattern net for rendered text,
 * not a general secrets scrubber; a handler that echoes a raw credential into
 * an error message or a log string can still leak it through here. Works on a
 * plain string too (`redact` traverses whatever value it's handed), which is
 * how {@link appendRequestLogEntry} and {@link emitRequestLogEvent} reuse this
 * for `errorMessage` — a validation error echoes the offending value, a
 * constraint error quotes the conflicting row, so the error message is at
 * least as PII-dense as args and gets the same treatment (with the free-text
 * caveat above).
 *
 * `captureRaw` is the development escape hatch: in a dev environment the dispatch
 * site (`isDevEnvironment`) passes `true` to skip redaction so a developer can
 * see real arg/identity/error values; production always redacts. The dev
 * decision is made at the call site from the deployment env, never inferred
 * here — so a real deploy that omits the env var stays redacted.
 */
const redactArgs = (value: unknown, captureRaw = false): unknown => {
    if (captureRaw || value === null || value === undefined) {
        return value;
    }

    return redact(value, standardRules);
};

/**
 * SQL handles whose request-log table (and its back-filled columns) have already
 * been ensured in this isolate. Every read and write path calls
 * {@link ensureRequestLogTable} defensively and `appendRequestLogEntry` runs once
 * per RPC dispatch, so without memoizing, every dispatch re-ran `CREATE TABLE IF
 * NOT EXISTS` plus the two back-fill `ALTER TABLE`s below — and an `ALTER` for a
 * column that already exists THROWS, so two SQLite errors were being constructed
 * and swallowed per dispatch forever. `getRequestLog`/`getIssues` pay it twice
 * per read, and `getIssues` is a wildcard subscription re-run on every flush.
 *
 * A `WeakSet` so a torn-down shard's handle is collectable, and a fresh handle (a
 * new isolate after hibernation) re-ensures, which is correct — the same pattern
 * and the same reasoning as `function-metrics.ts` and `metric-history.ts`.
 */
const ensuredHandles = new WeakSet<SqlExec>();

/**
 * Create the `__lunora_reqlog__` table. `seq` is an `AUTOINCREMENT` primary
 * key, giving each shard a monotonic cursor the Logs tab pages through; the
 * `args`/`identity`/`tables_read`/`tables_written` columns hold JSON and are
 * `NULL`/empty when none was recorded. Idempotent, so read and write paths can
 * call it defensively.
 *
 * `error_fingerprint` is the {@link fingerprintError} grouping hash captured
 * from the RAW `error_message` at write time, before {@link appendRequestLogEntry}
 * redacts it — see that function's docstring. `trace_id` is the dispatch's W3C
 * trace id, the correlation key to the span ring and to whatever collector
 * `otlpSink` ships to.
 *
 * Both are also added via a guarded `ALTER TABLE`, mirroring
 * `function-metrics.ts`'s `ensureFunctionMetricsTables`, so a shard whose
 * `__lunora_reqlog__` predates a column gains it on the next call without a
 * migration. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the duplicate-column
 * error from a re-run (or from the freshly-created schema above) is swallowed
 * per column — the loop is what keeps one column's duplicate from skipping the
 * next column's add.
 */
const ensureRequestLogTable = (sql: SqlExec): void => {
    if (ensuredHandles.has(sql)) {
        return;
    }

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
            error_fingerprint TEXT,
            trace_id TEXT,
            duration_ms REAL NOT NULL,
            tables_read TEXT NOT NULL DEFAULT '[]',
            tables_written TEXT NOT NULL DEFAULT '[]',
            cache_hit INTEGER,
            subscriptions_rerun INTEGER NOT NULL DEFAULT 0
        )`,
    );

    for (const column of ADDED_COLUMNS) {
        try {
            runSql(sql, `ALTER TABLE "${REQUEST_LOG_TABLE}" ADD COLUMN ${column}`);
        } catch {
            // Column already exists — no-op.
        }
    }

    ensuredHandles.add(sql);
};

/** Serialise a table list to a sorted, de-duplicated JSON array so the `LIKE` table-touched filter matches deterministically. */
const encodeTables = (tables: string[] | undefined): string => JSON.stringify([...new Set(tables)].toSorted((a, b) => a.localeCompare(b)));

/**
 * SQLite tri-state for a cache-hit flag: `1`/`0` when known, `null` when the cache is off or the path isn't cached.
 * @returns `1` for a hit, `0` for a miss, or `null` when the cache state is unknown
 */
const cacheHitColumn = (cacheHit: boolean | undefined): null | number => {
    if (cacheHit === undefined) {
        // eslint-disable-next-line unicorn/no-null -- SQL NULL: cache hit/miss unknown (cache disabled or non-cached path).
        return null;
    }

    return cacheHit ? 1 : 0;
};

/**
 * Append one dispatch to the request log, then trim the log back to the most
 * recent `retention` rows (default {@link REQUEST_LOG_RETENTION}). Creates the
 * table first so callers needn't. Args/identity/error message are redacted here
 * so a raw value never reaches the durable table — callers pass the unredacted
 * entry and rely on this, unless `captureRaw` (dev only) is set. `retention` is
 * the operator's `LUNORA_REQUEST_LOG_RETENTION` override, threaded in by the
 * dispatch site.
 *
 * The error-grouping fingerprint is computed from `entry.errorMessage` BEFORE
 * it's redacted below, and the resulting hash is persisted in
 * `error_fingerprint`. `readErrorIssues` groups off that stored hash instead of
 * recomputing `fingerprintError` from the (redacted) `error_message` column, so
 * masking a PII-bearing value — e.g. two different `<n>`-bucketed IDs that
 * redact to two different tag lengths (`<DL>` vs `<BANKACC>`) — can't split an
 * existing Issue or change its identity.
 */
const appendRequestLogEntry = (sql: SqlExec, entry: AppendRequestLogEntry, options: RequestLogWriteOptions = {}): void => {
    ensureRequestLogTable(sql);

    const captureRaw = options.captureRaw ?? false;
    const retention = options.retention ?? REQUEST_LOG_RETENTION;

    // Fingerprint the RAW message — `fingerprintError` is pure/synchronous and
    // cheap, so this costs nothing on the (rare) error path. `undefined` on a
    // success row: `readErrorIssues` only ever reads `outcome = 'error'` rows.
    const errorFingerprint =
        entry.outcome === "error" && entry.errorMessage !== undefined
            ? fingerprintError({ functionPath: entry.functionPath, message: entry.errorMessage }).hash
            : undefined;

    runSql(
        sql,
        `INSERT INTO "${REQUEST_LOG_TABLE}"
            (ts, function_path, shard_key, user_id, identity, args, outcome, error_message, error_fingerprint, trace_id, duration_ms, tables_read, tables_written, cache_hit, subscriptions_rerun)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.ts,
        entry.functionPath,
        // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct value for a request with no shard key / anonymous caller / absent field.
        entry.shardKey ?? null,
        // eslint-disable-next-line unicorn/no-null -- anonymous request: no acting user.
        entry.userId ?? null,
        // Identity claims (email/name/roles) are PII, so they're redacted by
        // default exactly like args — keeping the envelope's shape for the
        // studio while keeping raw PII out of the durable log. The opaque
        // `user_id` column above stays raw; it's the non-PII correlation key the
        // `getRequestLog` filters key on.
        // eslint-disable-next-line unicorn/no-null -- anonymous request or no claims attached.
        entry.identity === undefined ? null : JSON.stringify(redactArgs(entry.identity, captureRaw)),
        // eslint-disable-next-line unicorn/no-null -- no args were sent on this dispatch.
        entry.redactedArgs === undefined ? null : JSON.stringify(redactArgs(entry.redactedArgs, captureRaw)),
        entry.outcome,
        // eslint-disable-next-line unicorn/no-null -- success path: no error message. Redacted like args/identity — see the module docstring on `redactArgs`.
        entry.errorMessage === undefined ? null : redactArgs(entry.errorMessage, captureRaw),
        // eslint-disable-next-line unicorn/no-null -- success path, or a legacy row appended before this column existed.
        errorFingerprint ?? null,
        // Never redacted: a trace id is a random 32-hex identifier, not user
        // data, and redacting it would destroy the only thing it is for.
        // eslint-disable-next-line unicorn/no-null -- dispatch with no ambient trace, or a legacy row appended before this column existed.
        entry.traceId ?? null,
        entry.durationMs,
        encodeTables(entry.tablesRead),
        encodeTables(entry.tablesWritten),
        cacheHitColumn(entry.cacheHit),
        entry.subscriptionsReRun ?? 0,
    );

    // Bounded retention: drop every row older than the most recent `retention`
    // by `seq`, mirroring `trimCdcChanges`/audit trim.
    runSql(sql, `DELETE FROM "${REQUEST_LOG_TABLE}" WHERE seq <= (SELECT MAX(seq) - ? FROM "${REQUEST_LOG_TABLE}")`, retention);
};

/**
 * Emit one structured request event to `console` so Cloudflare's Workers Logs /
 * Logpush pipeline carries it to external sinks (SIEMs) — PLAN3 §3.3. This does
 * NOT reimplement a transport: it produces a richer, lunora-attributed event and
 * lets CF's existing trace-log pipe ship it. The event mirrors the durable
 * `__lunora_reqlog__` row (function path, shard, user, outcome, duration, tables
 * read/written, cache hit), with `args`, `identity`, AND `error` redacted
 * exactly like the durable write so no raw PII/secret reaches the log pipeline.
 *
 * An `error` outcome goes to `console.error` (surfacing at error level in the
 * trace so a SIEM can alert on it); everything else to `console.log`. The
 * `source: "lunora"` / `type: "request"` envelope lets a consumer filter these
 * events out of the raw Workers-trace firehose. `captureRaw` (dev only) skips
 * redaction, mirroring the durable write. Best-effort by contract — the caller
 * wraps it so a serialization hiccup can never fail the served request.
 */
const emitRequestLogEvent = (entry: AppendRequestLogEntry, options: RequestLogWriteOptions = {}): void => {
    const captureRaw = options.captureRaw ?? false;
    const event = {
        args: entry.redactedArgs === undefined ? undefined : redactArgs(entry.redactedArgs, captureRaw),
        cacheHit: entry.cacheHit,
        durationMs: entry.durationMs,
        error: entry.errorMessage === undefined ? undefined : redactArgs(entry.errorMessage, captureRaw),
        function: entry.functionPath,
        identity: entry.identity === undefined ? undefined : redactArgs(entry.identity, captureRaw),
        outcome: entry.outcome,
        shard: entry.shardKey,
        source: REQUEST_LOG_EVENT_SOURCE,
        tablesRead: entry.tablesRead ?? [],
        tablesWritten: entry.tablesWritten ?? [],
        // The join key on the far side: a SIEM receiving this event and an OTLP
        // collector receiving the same dispatch's spans can only be correlated
        // through the trace id, so emitting it here is most of the point of
        // recording it at all.
        traceId: entry.traceId,
        ts: entry.ts,
        type: "request",
        userId: entry.userId,
    };

    const line = JSON.stringify(event);

    if (entry.outcome === "error") {
        // eslint-disable-next-line no-console -- intentional structured event emission into CF Workers Logs / Logpush (PLAN3 §3.3); error outcome at error level.
        console.error(line);
    } else {
        // eslint-disable-next-line no-console -- intentional structured event emission into CF Workers Logs / Logpush (PLAN3 §3.3).
        console.log(line);
    }
};

/**
 * The `ctx.log` event contract (shape + severity union) lives in
 * `shared/log-event.ts` (inlined into each `dist`) so the DO that builds these
 * events and the `@lunora/runtime` sink that consumes them agree by construction.
 * `LogEventInput` is the DO's historical name for the shared `LogEvent`.
 */
type LogEventInput = LogEvent;

/** Stable `type` tag distinguishing a per-call application-log event from the per-dispatch `"request"` event; both share `source: "lunora"`. */
const LOG_EVENT_TYPE = "log";

/**
 * Render `ctx.log.*` arguments into a single display string, the way `console`
 * does: strings pass through verbatim; everything else is JSON-serialised (with
 * a `String()` fallback for a circular/unserialisable value so rendering never
 * throws). Values are space-joined. This rendered string is what the dev-server
 * terminal shows; the structured `args` array travels alongside it for sinks
 * that want the raw values.
 */
const renderLogMessage = (args: unknown[]): string =>
    args
        .map((value) => {
            if (typeof value === "string") {
                return value;
            }

            try {
                // `JSON.stringify` is typed `=> string` but returns `undefined`
                // for a function/symbol/undefined value — fall back to `String`.
                const json = JSON.stringify(value) as string | undefined;

                return json ?? String(value);
            } catch {
                return String(value);
            }
        })
        .join(" ");

/**
 * True only for a **plain** object usable as a structured-fields bag — an object
 * literal or a null-prototype bag, not an array, `Error`, `Date`, `Map`, or any
 * class instance. This keeps the ubiquitous console-style idiom
 * `ctx.log.error("failed", err)` on the render path (where the `Error` is shown)
 * instead of misrouting it into the structured branch, where `normalizeLogFields`
 * would find no own enumerable fields and silently drop it.
 */
const isLogFields = (value: unknown): value is LogFields => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const proto: unknown = Object.getPrototypeOf(value);

    return proto === Object.prototype || proto === null;
};

/**
 * Split a `ctx.log.<level>(...)` call's raw arguments into a display `message`
 * and optional structured `fields`. The structured form — a message string plus
 * a plain-object fields bag — is matched only for exactly `(string, object)`;
 * every other shape is console-style and rendered whole (so existing
 * `console`-shaped calls are unchanged). Bound `.with(...)` fields merge under
 * the per-call fields (per-call wins); the result is normalized to a fresh bag
 * of JSON-safe primitives, or `undefined` when empty (see `normalizeLogFields`).
 */
const parseLogArgs = (args: unknown[], boundFields?: LogFields): { fields?: LogFields; message: string } => {
    if (args.length === 2 && typeof args[0] === "string" && isLogFields(args[1])) {
        return { fields: normalizeLogFields(args[1], boundFields), message: args[0] };
    }

    return { fields: normalizeLogFields(undefined, boundFields), message: renderLogMessage(args) };
};

/**
 * Emit one application-log event from a `ctx.log.*` call to `console`, tagged
 * `{ source: "lunora", type: "log" }` so the CLI / Vite formatter can pretty-print
 * it in the dev terminal and a Logpush/SIEM consumer can filter it out of the
 * raw Workers-trace firehose.
 *
 * Only the rendered `message` is emitted here, NOT the structured `args` array:
 * the console event rides CF Workers Logs / Logpush to prod, and shipping raw,
 * un-redacted arg objects on a `source: "lunora"` line a SIEM is told to trust
 * would be a surprising PII/secret surface. The raw `args` stay on the in-process
 * `sink.onLog` path (`recordUserLog`), which the operator opts into and controls.
 * `message` already carries the developer's rendered values, exactly like a raw
 * `console.log` line.
 *
 * `error`/`fatal` go to `console.error`, `warn` to `console.warn` (so they
 * surface at the right level in the trace); every other level to `console.log`.
 *
 * Structured `fields` (plus `traceId`/`spanId` for correlation) ARE emitted here
 * — they are intentional metadata a log pipeline filters on, unlike raw `args`.
 * Unlike `args`, `fields` IS redacted before it rides this console line — a
 * developer can attach anything to a fields bag (`ctx.log.info("charged",
 * { email, cardLast4 })`), and this is the one line that's told to a SIEM as
 * trustworthy, exactly like the request-log `args`/`identity`/`error` columns.
 * `options.captureRaw` (dev only) skips it, mirroring every other redaction
 * point in this module; the sole current caller (`ShardDO.recordUserLog`)
 * doesn't yet thread a dev flag through, so `fields` redacts unconditionally
 * there today — a conservative default, never a correctness gap. A field value
 * that can't be serialised (a circular object) would make `JSON.stringify`
 * throw and drop the whole line, so serialisation falls back to a fields-free
 * line rather than losing the event.
 */
const emitLogEvent = (input: LogEventInput, options: RequestLogWriteOptions = {}): void => {
    const captureRaw = options.captureRaw ?? false;
    const payload = {
        fields: input.fields === undefined ? undefined : redactArgs(input.fields, captureRaw),
        function: input.functionPath,
        level: input.level,
        message: input.message,
        shard: input.shardKey,
        source: REQUEST_LOG_EVENT_SOURCE,
        spanId: input.spanId,
        traceId: input.traceId,
        ts: input.ts,
        type: LOG_EVENT_TYPE,
        userId: input.userId,
    };

    let line: string;

    try {
        line = JSON.stringify(payload);
    } catch {
        // A non-serialisable field (e.g. circular) must not swallow the line —
        // drop `fields` and emit the rest.
        line = JSON.stringify({ ...payload, fields: undefined });
    }

    if (input.level === "error" || input.level === "fatal") {
        // eslint-disable-next-line no-console -- intentional structured ctx.log event emission into CF Workers Logs / Logpush; error level.
        console.error(line);
    } else if (input.level === "warn") {
        // eslint-disable-next-line no-console -- intentional structured ctx.log event emission into CF Workers Logs / Logpush; warn level.
        console.warn(line);
    } else {
        // eslint-disable-next-line no-console -- intentional structured ctx.log event emission into CF Workers Logs / Logpush.
        console.log(line);
    }
};

/**
 * A prefix / substring test that is not a `LIKE` pattern.
 *
 * Workerd caps `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` at 50 bytes and this table
 * lives in a Durable Object, so `function_path LIKE 'prefix%'` failed the whole
 * read with "LIKE or GLOB pattern too complex" once the prefix passed ~49
 * characters — which a Lunora function path reaches easily
 * (`api/admin/billing/subscriptions/reconcileStripeWebhook` is 54). `substr` and
 * `instr` carry no pattern, so they have no length ceiling, and they take the
 * term literally — which also retires the wildcard escaping this used to need.
 *
 * Both sides go through SQLite's `lower()` because that is the case folding
 * `LIKE` applied and therefore the behaviour callers already have — folding in
 * JS instead would diverge on non-ASCII, where `lower()` is a no-op and
 * `toLowerCase()` is not.
 *
 * `substr`'s length is the term's code-point count (what SQLite counts), not its
 * UTF-16 length, and it is interpolated as an integer literal rather than bound
 * so the comparison stays a plain equality.
 */
const prefixTest = (column: string, term: string): string =>
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points is exactly the unit wanted: SQLite's `substr` counts them, so `term.length` (UTF-16 units) would over-count any astral character and slice a longer prefix than the term.
    `lower(substr(${column}, 1, ${String([...term].length)})) = lower(?)`;

/** Append the scope filters {@link readRequestLog} and {@link readErrorIssues} share (function-path prefix, exact userId/shardKey), each as a bound parameter. */
const pushScopeFilters = (conjuncts: string[], parameters: unknown[], options: { functionPathPrefix?: string; shardKey?: string; userId?: string }): void => {
    if (options.functionPathPrefix !== undefined && options.functionPathPrefix !== "") {
        conjuncts.push(prefixTest("function_path", options.functionPathPrefix));
        parameters.push(options.functionPathPrefix);
    }

    if (options.userId !== undefined && options.userId !== "") {
        conjuncts.push("user_id = ?");
        parameters.push(options.userId);
    }

    if (options.shardKey !== undefined && options.shardKey !== "") {
        conjuncts.push("shard_key = ?");
        parameters.push(options.shardKey);
    }
};

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
    trace_id: null | string;
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

/** Parse a stored `identity` JSON blob back into an object, tolerating a malformed value rather than throwing on a read — the field is simply omitted, not replaced with a placeholder. */
const decodeIdentity = (raw: string): Record<string, unknown> | undefined => {
    try {
        const value = JSON.parse(raw) as unknown;

        return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
};

/** Parse a stored `args` JSON blob back into the redacted-args value, tolerating a malformed value rather than throwing on a read — the field is simply omitted, not replaced with a placeholder. */
const decodeRedactedArgs = (raw: string): unknown => {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return undefined;
    }
};

/**
 * Read request-log entries, AND-combining the supplied filters (function-path
 * prefix, exact userId/shardKey/outcome, and a table-touched match against the
 * read OR written table sets), up to `limit` (clamped to [1, 10000]). Each value
 * is a bound parameter, so no filter can inject SQL. Creates the table first so
 * reads on a never-logged shard return `[]` instead of throwing. Mirrors
 * `readAuditLog`/`readCdcChanges`.
 *
 * **Ordering follows `sinceSeq`.** Without a cursor this is a "show me the tail"
 * read and returns NEWEST FIRST, which is what the studio's Logs tab renders.
 * With `sinceSeq` it is forward paging and returns OLDEST FIRST, starting at the
 * cursor: descending there silently loses rows, because `ORDER BY seq DESC LIMIT
 * n` answers "the newest n after the cursor", so a consumer that advances to the
 * largest returned `seq` skips everything between `sinceSeq` and that page
 * whenever more than `limit` rows accumulated between polls — the more traffic
 * the shard takes, the more it drops.
 */
const readRequestLog = (sql: SqlExec, options: ReadRequestLogOptions = {}): RequestLogEntry[] => {
    ensureRequestLogTable(sql);

    const limit = Math.max(1, Math.min(options.limit ?? REQUEST_LOG_RETENTION, 10_000));

    const conjuncts: string[] = ["seq > ?"];
    const parameters: unknown[] = [options.sinceSeq ?? 0];

    pushScopeFilters(conjuncts, parameters, options);

    if (options.outcome !== undefined) {
        conjuncts.push("outcome = ?");
        parameters.push(options.outcome);
    }

    if (options.tableTouched !== undefined && options.tableTouched !== "") {
        // Tables are stored as a JSON string array (e.g. `["a","b"]`), so a
        // quoted-substring test matches an exact table name without colliding on
        // a prefix (`"posts"` never matches inside `"posts_archive"`).
        const needle = JSON.stringify(options.tableTouched);

        conjuncts.push("(instr(lower(tables_read), lower(?)) > 0 OR instr(lower(tables_written), lower(?)) > 0)");
        parameters.push(needle, needle);
    }

    parameters.push(limit);

    // See the ordering paragraph above: a cursored read pages FORWARD from it.
    const direction = options.sinceSeq === undefined ? "DESC" : "ASC";

    const rows = runSql<RequestLogRow>(
        sql,
        `SELECT seq, ts, function_path, shard_key, user_id, identity, args, outcome, error_message, trace_id, duration_ms, tables_read, tables_written, cache_hit, subscriptions_rerun
         FROM "${REQUEST_LOG_TABLE}" WHERE ${conjuncts.join(" AND ")} ORDER BY seq ${direction} LIMIT ?`,
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
            const identity = decodeIdentity(row.identity);

            if (identity !== undefined) {
                base.identity = identity;
            }
        }

        if (row.args !== null) {
            const redactedArgs = decodeRedactedArgs(row.args);

            if (redactedArgs !== undefined) {
                base.redactedArgs = redactedArgs;
            }
        }

        if (row.error_message !== null) {
            base.errorMessage = row.error_message;
        }

        if (row.cache_hit !== null) {
            base.cacheHit = row.cache_hit === 1;
        }

        if (row.trace_id !== null) {
            base.traceId = row.trace_id;
        }

        return base;
    });
};

/**
 * Group the recent `error`-outcome request-log rows into stable **Issues**.
 *
 * A pure read-side aggregation over the bounded readout — no new storage beyond
 * the `error_fingerprint` column, no transport (see the module docstring): it
 * reads the recent `error` rows and folds them by grouping hash, matching the
 * grouping a cloud Incident uses. `@lunora/fingerprint`'s `fingerprintError`
 * canonical hash is `functionPath :: bucket(message)`, which collapses
 * per-occurrence noise — a route-scanner sweep (`/wp-admin`, `/.env`), a
 * per-request id in the message (`user 12345 not found`) — onto one Issue.
 * Container crashes fold in too, since they land as `error` rows under
 * `functionPath: "container:<name>"`.
 *
 * The grouping hash used per row is `row.error_fingerprint` when present —
 * computed by {@link appendRequestLogEntry} from the RAW message, before
 * redaction, at write time — falling back to recomputing `fingerprintError`
 * from the stored (redacted) `error_message` only for a row written before that
 * column existed. `title`/`culprit` are always (re)computed from the stored
 * message here, so they track whatever `sampleMessage` shows (redacted, for a
 * post-migration row). A pre-migration fallback row's stored `error_message` is
 * itself still the original raw text (this redaction fix and the
 * `error_fingerprint` column ship together, so no row has a redacted message
 * without also having a stored hash), so its recomputed hash matches history —
 * it doesn't actually re-bucket in practice, but even if some future change
 * broke that invariant the blast radius is bounded: `__lunora_reqlog__` caps at
 * `REQUEST_LOG_RETENTION` rows per shard and ages out fast.
 *
 * Rows come back in `seq` (insert) order, which is NOT `ts` order: a container
 * lifecycle row carries the caller's envelope `ts`, so an out-of-order or
 * clock-skewed push can land an older-`ts` row at a higher `seq`. The
 * representative `title`/`sampleMessage` are therefore tracked by maximum `ts`,
 * not by first sighting, so they always describe the same occurrence `lastSeen`
 * points at. `culprit` needs no such tracking — it is derived from
 * `functionPath` alone, which is invariant across a group. Result is ordered
 * most-recently-active first.
 *
 * This projects only the four columns grouping needs (`function_path`,
 * `error_message`, `error_fingerprint`, `ts`) instead of going through
 * {@link readRequestLog}'s full 14-column hydrate + per-row `JSON.parse` of
 * args/identity/tables — none of which the fold reads. The `getIssues`
 * subscription carries the admin wildcard, so it re-runs on every write-flush;
 * keeping this read lean matters.
 */

/**
 * Join each derived Issue with its persisted triage state, in place. A hash with
 * no state row keeps the implicit `open` default; otherwise status/assignee/
 * severity/`stateUpdatedAt` are folded in — with the auto-reopen rule: a
 * `resolved` Issue that erred again AFTER it was resolved surfaces as `open` (a
 * regression, so the fix isn't silently undone), while `ignored` stays sticky.
 */
const applyIssueStates = (sql: SqlExec, issues: Map<string, ErrorIssue>): void => {
    const states = readIssueStates(sql, [...issues.keys()]);

    for (const issue of issues.values()) {
        const state = states.get(issue.hash);

        if (state === undefined) {
            continue;
        }

        issue.stateUpdatedAt = state.updatedAt;

        if (state.assignee !== undefined) {
            issue.assignee = state.assignee;
        }

        if (state.severity !== undefined) {
            issue.severity = state.severity;
        }

        issue.status = state.status === "resolved" && issue.lastSeen > state.updatedAt ? "open" : state.status;
    }
};

const readErrorIssues = (sql: SqlExec, options: ReadIssuesOptions = {}): ErrorIssue[] => {
    ensureRequestLogTable(sql);

    const limit = Math.max(1, Math.min(options.limit ?? REQUEST_LOG_RETENTION, 10_000));

    const conjuncts: string[] = ["outcome = 'error'"];
    const parameters: unknown[] = [];

    pushScopeFilters(conjuncts, parameters, options);

    parameters.push(limit);

    const rows = runSql<{ error_fingerprint: null | string; error_message: null | string; function_path: string; ts: number }>(
        sql,
        `SELECT function_path, error_message, error_fingerprint, ts
         FROM "${REQUEST_LOG_TABLE}" WHERE ${conjuncts.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
        ...parameters,
    ).toArray();

    const issues = new Map<string, ErrorIssue>();
    /** `ts` of the row currently supplying each Issue's `title`/`sampleMessage`. */
    const sampleTs = new Map<string, number>();

    for (const row of rows) {
        const message = row.error_message ?? "";
        // `culprit`/`title` always come from the stored (possibly redacted)
        // message, so they stay consistent with `sampleMessage`; the grouping
        // `hash` prefers the write-time value captured from the RAW message
        // (see the docstring above) and only falls back to this recomputation
        // for a row with no stored fingerprint.
        const { culprit, hash: computedHash, title } = fingerprintError({ functionPath: row.function_path, message });
        const hash = row.error_fingerprint ?? computedHash;
        const existing = issues.get(hash);

        if (existing === undefined) {
            // `status` seeds to `open`; the persisted-state fold below overrides it.
            issues.set(hash, { count: 1, culprit, firstSeen: row.ts, hash, lastSeen: row.ts, sampleMessage: message, status: "open", title });
            sampleTs.set(hash, row.ts);

            continue;
        }

        existing.count += 1;
        existing.firstSeen = Math.min(existing.firstSeen, row.ts);
        existing.lastSeen = Math.max(existing.lastSeen, row.ts);

        // Strictly newer only, so a `ts` tie keeps the higher-`seq` (later-written) row.
        if (row.ts > (sampleTs.get(hash) ?? Number.NEGATIVE_INFINITY)) {
            sampleTs.set(hash, row.ts);
            existing.sampleMessage = message;
            existing.title = title;
        }
    }

    // Fold in the persisted triage state, batched over the folded hash set so the
    // subscription's per-flush re-run stays a single extra `WHERE hash IN (...)`.
    applyIssueStates(sql, issues);

    const folded = [...issues.values()];
    const filtered = options.status === undefined ? folded : folded.filter((issue) => issue.status === options.status);

    return filtered.toSorted((a, b) => b.lastSeen - a.lastSeen);
};

export {
    appendRequestLogEntry,
    emitLogEvent,
    emitRequestLogEvent,
    ensureRequestLogTable,
    parseLogArgs,
    readErrorIssues,
    readRequestLog,
    redactArgs,
    renderLogMessage,
    REQUEST_LOG_RETENTION,
    REQUEST_LOG_TABLE,
};
export type {
    AppendRequestLogEntry,
    ErrorIssue,
    IssuesResult,
    LogEventInput,
    ReadIssuesOptions,
    ReadRequestLogOptions,
    RequestLogEntry,
    RequestLogResult,
    RequestLogWriteOptions,
    RequestOutcome,
};
export { type ContextLogLevel } from "../../../shared/log-event";

// Re-exported straight from their source module (they're also imported above for
// local use in `ErrorIssue`/`ReadIssuesOptions`); `export…from` keeps the single
// source of truth per `unicorn/prefer-export-from`.
export type { IssueSeverity, IssueStatus } from "./issue-state";
