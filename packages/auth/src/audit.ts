/**
 * Durable, queryable auth/security audit trail.
 *
 * A reserved, append-only table that records authentication and security events
 * (sign-in, sign-up, token refresh, password change, MFA enable/disable, session
 * revoke, account link, …) so an operator can answer "who authenticated, from
 * where, and did it succeed" after the fact — the compliance/forensics surface
 * Supabase (`auth.audit_log_entries`) and Firebase expose.
 *
 * It deliberately mirrors the reserved-table pattern of `@lunora/do`'s admin
 * audit log (`packages/do/src/audit-log.ts`) — an `AUTOINCREMENT` `seq` cursor,
 * an `ensure`/`append`/`read` trio, JSON `detail` — with two differences the
 * plan calls for. First, retention is configurable and NOT capped at 1000:
 * compliance use wants a long (often unbounded) trail, so it is an explicit
 * option and omitting it keeps every row. Second, the free-form `detail` payload
 * is scrubbed with `@visulima/redact` before it is persisted, so a token or
 * password that leaks into an event's context never reaches the durable table.
 *
 * Persistence rides the same {@link SqlExecutor} seam better-auth's store uses
 * (`./sql-store`), so it lands in the same D1 database as the auth tables — no
 * new binding, and edge-safe (D1 is available on workerd).
 */

import { piiRules, redact, standardRules } from "@visulima/redact";

import type { SqlExecutor } from "./sql-store";

/** Reserved append-only table backing the Studio "Security / audit" page. Auto-hidden from the data browser by the `__lunora` prefix. */
const AUTH_AUDIT_TABLE = "__lunora_auth_audit__";

/**
 * Well-known auth/security event types. A plain `string` is also accepted so
 * plugins can record their own events without a union change — the union just
 * gives autocomplete for the common ones.
 */
type AuthAuditEvent =
    | "account-link"
    | "account-unlink"
    | "email-verification"
    | "mfa-disable"
    | "mfa-enable"
    | "password-change"
    | "password-reset"
    | "session-revoke"
    | "sign-in"
    // A sign-in-family endpoint that only DISPATCHES (mints a provider
    // redirect URL, or sends a magic-link email) — nobody is authenticated
    // yet. Split out from `sign-in` (plan 280) so a caller can't mistake it
    // for a completed authentication.
    | "sign-in-initiated"
    | "sign-out"
    | "sign-up"
    | "token-refresh"
    | (string & {});

/** Whether the recorded operation succeeded or failed (e.g. a rejected sign-in). */
type AuthAuditOutcome = "failure" | "success";

/** One recorded auth/security event, in monotonic `seq` order. */
interface AuthAuditEntry {
    /** Redaction is applied to `detail`, not this — the actor's email is intentional forensic data. Absent for anonymous/pre-auth events. */
    actorEmail?: string;
    /** The acting user's id, when known. */
    actorId?: string;
    /** JSON-decoded extra context, with secrets/PII redacted at write time; absent when none was recorded. */
    detail?: Record<string, unknown>;
    /** Auth event type, e.g. `sign-in` / `password-change`. */
    event: string;
    /** Client IP the event originated from, when resolvable. */
    ip?: string;
    /** Whether the operation succeeded or failed. */
    outcome: AuthAuditOutcome;
    /** Monotonic per-database cursor — strictly increasing, never reused. */
    seq: number;

    /**
     * The identifier (email or username) a sign-in-family request ATTEMPTED,
     * read from the request body. Present for both successful and failed
     * attempts — unlike `actorEmail` (which requires an authenticated
     * session), this is what lets a FAILED credential-stuffing attempt be
     * grouped by target. Same redaction exemption as `actorEmail`: a
     * top-level column, not a `detail` key, because `AUDIT_REDACT_RULES`
     * scrubs email-shaped values inside `detail` regardless of key name —
     * putting it there would erase exactly this datum. Length-capped to 320
     * chars (RFC 5321) since it carries attacker-controlled request-body text.
     */
    targetEmail?: string;
    /** Wall-clock millis when the event was recorded. */
    ts: number;
    /** Client User-Agent, when present on the request. */
    userAgent?: string;
}

/** Fields accepted when appending one event; `seq` is assigned by the table. */
interface AppendAuthAuditEntry {
    actorEmail?: string;
    actorId?: string;
    detail?: Record<string, unknown>;
    event: string;
    ip?: string;
    outcome: AuthAuditOutcome;
    /** See {@link AuthAuditEntry.targetEmail}. */
    targetEmail?: string;
    ts: number;
    userAgent?: string;
}

/** Options for {@link appendAuthAuditEntry}. */
interface AppendAuthAuditOptions {
    /**
     * Redact secrets/PII in the `detail` payload before persisting. Defaults to
     * `true`. Set `false` only for a trusted, pre-scrubbed payload.
     */
    redactDetail?: boolean;

    /**
     * Keep only the most recent `retention` rows (trimmed after each append),
     * mirroring the admin audit log's bounded retention. Omit for an unbounded
     * trail (the compliance default) — deliberately NOT capped at 1000.
     */
    retention?: number;
}

/** Options for {@link readAuthAuditLog}. */
interface ReadAuthAuditOptions {
    /** Return only events for this actor id. */
    actorId?: string;
    /** Return only events of this type. */
    event?: string;
    /** Max rows to return, clamped to [1, 10000]. Defaults to 1000. */
    limit?: number;
    /** Return only events with `seq` strictly greater than this (forward paging). */
    sinceSeq?: number;
}

/** Merged rule set: credential/secret scrubbing (`standardRules`) plus PII (`piiRules`) for the free-form detail payload. */
const AUDIT_REDACT_RULES = [...standardRules, ...piiRules];

const DEFAULT_READ_LIMIT = 1000;

const MAX_READ_LIMIT = 10_000;

// SQL NULL is the correct stored value for an absent optional column; the store
// seam is untyped, so `null` is unavoidable here.
// eslint-disable-next-line unicorn/no-null -- SQL NULL literal for absent columns
const SQL_NULL = null;

/** Coerce an untyped SQLite cell (TEXT/REAL → string/number/null) to a string, or `undefined` when NULL/absent. Avoids `String(unknown)` base-to-string. */
const text = (value: unknown): string | undefined => {
    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
        return String(value);
    }

    return undefined;
};

/**
 * Create the `__lunora_auth_audit__` table. `seq` is an `AUTOINCREMENT` primary
 * key giving the database a monotonic cursor the Security page pages through.
 * Idempotent, so read and write paths can call it defensively.
 *
 * `target_email` is added via a guarded `ALTER TABLE` rather than baked only
 * into the `CREATE`, mirroring `@lunora/observability`'s
 * `ensureRequestLogTable`/`ensureFunctionMetricsTables` — `CREATE TABLE IF NOT
 * EXISTS` only helps a table that doesn't exist yet, so a database whose audit
 * table predates this column needs the `ALTER` to gain it. SQLite has no `ADD
 * COLUMN IF NOT EXISTS`; the duplicate-column error from a re-run (or from the
 * column already existing on the freshly-created schema above) is swallowed —
 * anything else re-throws, so a genuinely broken executor is not silently
 * papered over.
 */
const ensureAuthAuditTable = async (executor: SqlExecutor): Promise<void> => {
    await executor.run(
        `CREATE TABLE IF NOT EXISTS "${AUTH_AUDIT_TABLE}" (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            event TEXT NOT NULL,
            outcome TEXT NOT NULL,
            actor_id TEXT,
            actor_email TEXT,
            target_email TEXT,
            ip TEXT,
            user_agent TEXT,
            detail TEXT
        )`,
        [],
    );

    try {
        await executor.run(`ALTER TABLE "${AUTH_AUDIT_TABLE}" ADD COLUMN target_email TEXT`, []);
    } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

        if (!message.includes("duplicate column")) {
            throw error;
        }
    }
};

/**
 * Append one auth event, redacting its `detail` payload (unless disabled) and —
 * when `retention` is set — trimming the log back to the most recent rows.
 * Creates the table first so callers needn't. Returns the redacted, persisted
 * entry (sans `seq`) so an export tap can forward exactly what was stored.
 */
const appendAuthAuditEntry = async (
    executor: SqlExecutor,
    entry: AppendAuthAuditEntry,
    options: AppendAuthAuditOptions = {},
): Promise<AppendAuthAuditEntry> => {
    await ensureAuthAuditTable(executor);

    let detail: Record<string, unknown> | undefined;

    if (entry.detail !== undefined) {
        detail = options.redactDetail === false ? entry.detail : redact(entry.detail, AUDIT_REDACT_RULES);
    }

    await executor.run(
        `INSERT INTO "${AUTH_AUDIT_TABLE}" (ts, event, outcome, actor_id, actor_email, target_email, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            entry.ts,
            entry.event,
            entry.outcome,
            entry.actorId ?? SQL_NULL,
            entry.actorEmail ?? SQL_NULL,
            entry.targetEmail ?? SQL_NULL,
            entry.ip ?? SQL_NULL,
            entry.userAgent ?? SQL_NULL,
            detail === undefined ? SQL_NULL : JSON.stringify(detail),
        ],
    );

    // Bounded retention only when asked: drop every row older than the most
    // recent `retention` by `seq`, mirroring the admin log's `trimCdcChanges`.
    // Omitted retention keeps the full trail (compliance default).
    if (typeof options.retention === "number" && options.retention > 0) {
        await executor.run(`DELETE FROM "${AUTH_AUDIT_TABLE}" WHERE seq <= (SELECT MAX(seq) - ? FROM "${AUTH_AUDIT_TABLE}")`, [options.retention]);
    }

    return { ...entry, detail };
};

/**
 * Read audit events newest-first, optionally filtered by `actorId` / `event` and
 * paged past `sinceSeq`, up to `limit` (clamped to [1, 10000]). Parses each row's
 * `detail` JSON back into an object. Creates the table first so reads on a
 * never-audited database return `[]` instead of throwing.
 *
 * `limit` is NaN-safe: a non-finite/non-number value (e.g. a caller passing
 * `Number.NaN`, or an upstream boundary that failed to reject one) falls back
 * to {@link DEFAULT_READ_LIMIT} rather than reaching `Math.min`/`Math.max`,
 * which both propagate `NaN` and would otherwise bind it as the SQL `LIMIT`
 * parameter. This is the library-level fix; `#readAudit` (`./auth-do`) also
 * rejects a non-numeric `limit` at the boundary with a 400 — this clamp is the
 * safety net for every OTHER caller of this function too.
 */
const readAuthAuditLog = async (executor: SqlExecutor, options: ReadAuthAuditOptions = {}): Promise<AuthAuditEntry[]> => {
    await ensureAuthAuditTable(executor);

    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit as number, MAX_READ_LIMIT)) : DEFAULT_READ_LIMIT;
    const clauses: string[] = ["seq > ?"];
    const parameters: unknown[] = [options.sinceSeq ?? 0];

    if (options.actorId !== undefined) {
        clauses.push("actor_id = ?");
        parameters.push(options.actorId);
    }

    if (options.event !== undefined) {
        clauses.push("event = ?");
        parameters.push(options.event);
    }

    parameters.push(limit);

    const rows = await executor.all(
        `SELECT seq, ts, event, outcome, actor_id, actor_email, target_email, ip, user_agent, detail FROM "${AUTH_AUDIT_TABLE}" WHERE ${clauses.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
        parameters,
    );

    return rows.map((row): AuthAuditEntry => {
        const base: AuthAuditEntry = {
            event: text(row["event"]) ?? "",
            outcome: row["outcome"] === "failure" ? "failure" : "success",
            seq: Number(row["seq"]),
            ts: Number(row["ts"]),
        };

        const optionalColumns = [
            ["actorId", "actor_id"],
            ["actorEmail", "actor_email"],
            ["targetEmail", "target_email"],
            ["ip", "ip"],
            ["userAgent", "user_agent"],
        ] as const;

        for (const [key, column] of optionalColumns) {
            const value = text(row[column]);

            if (value !== undefined) {
                base[key] = value;
            }
        }

        const detail = text(row["detail"]);

        if (detail !== undefined) {
            base.detail = JSON.parse(detail) as Record<string, unknown>;
        }

        return base;
    });
};

/**
 * The auth/security audit read plane the runtime's `authAuditReader` option
 * accepts — a structurally-compatible `{ read }` object the worker calls behind
 * its admin gate to back the studio's "Security / audit" page
 * (`__lunora_admin__:getAuthAuditLog`).
 */
interface AuthAuditReader {
    read: (options: ReadAuthAuditOptions) => Promise<AuthAuditEntry[]>;
}

/**
 * Build the reader the runtime's `authAuditReader` option accepts, closing over
 * the auth D1 `executor` (`d1Executor(env.DB)`) so an admin caller reads the same
 * `__lunora_auth_audit__` table the hook writes. Filters/paging pass straight
 * through to {@link readAuthAuditLog} (which clamps `limit`).
 *
 * ```ts
 * export default createWorker({
 *     authAuditReader: createAuthAuditReader(d1Executor(env.DB)),
 *     // …
 * });
 * ```
 */
const createAuthAuditReader = (executor: SqlExecutor): AuthAuditReader => {
    return {
        read: (options) => readAuthAuditLog(executor, options),
    };
};

export { appendAuthAuditEntry, AUTH_AUDIT_TABLE, createAuthAuditReader, ensureAuthAuditTable, readAuthAuditLog };
export type { AppendAuthAuditEntry, AppendAuthAuditOptions, AuthAuditEntry, AuthAuditEvent, AuthAuditOutcome, AuthAuditReader, ReadAuthAuditOptions };
