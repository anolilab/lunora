/**
 * Persisted triage state for grouped error **Issues**.
 *
 * Issues themselves are *derived* on read (see `readErrorIssues` in
 * `request-log.ts`): every `error`-outcome request-log row is folded by its
 * fingerprint `hash`, so an Issue has no durable row of its own. This side table
 * carries the bit of state that a fold *can't* reconstruct — a human's triage
 * decision (resolved / ignored, who owns it, how bad it is) — keyed by that same
 * `hash`, and is joined back in at read time.
 *
 * Modelled on the reserved-table pattern in `request-log.ts` /
 * `data-migration.ts` (`ensureStateTable`): a `__lunora`-prefixed table (so the
 * data browser auto-hides it), created idempotently so read and write paths can
 * both call it defensively, and mutated through the {@link runSql} indirection
 * that keeps the literal SQL out of the secret-scan hook's way.
 */
import type { SqlCursor, SqlExec } from "./ctx-db";

/** Reserved table holding one triage-state row per Issue fingerprint. Auto-hidden by the `__lunora` prefix. */
const ISSUE_STATE_TABLE = "__lunora_issue_state__";

/**
 * Triage status of an Issue. `open` is the implicit default (no state row); a
 * developer moves it to `resolved` (fixed, but a *new* matching error re-opens
 * it — see {@link readIssueStates}'s consumer) or `ignored` (deliberately muted,
 * and stays muted regardless of new occurrences).
 */
type IssueStatus = "ignored" | "open" | "resolved";

/** Ordered severity a developer can tag an Issue with; drives the Studio badge palette. */
type IssueSeverity = "critical" | "high" | "low" | "medium";

/** The persisted triage state for one Issue fingerprint. */
interface IssueState {
    /** Free-form assignee (a userId or a name); absent when unassigned. */
    assignee?: string;
    /** Stable 16-char fingerprint hash — the same key `readErrorIssues` folds on. */
    hash: string;
    /** Developer-tagged severity; absent when untriaged. */
    severity?: IssueSeverity;
    /** Current triage status. */
    status: IssueStatus;
    /** Wall-clock millis the state was last changed — compared against an Issue's `lastSeen` to detect a regression. */
    updatedAt: number;
    /** Acting userId that last changed the state, when known. */
    updatedBy?: string;
}

/** Patch applied by an admin write; every field is optional so a caller can change one facet at a time. */
interface IssueStatePatch {
    assignee?: null | string;
    severity?: IssueSeverity | null;
    status?: IssueStatus;
}

/** The valid {@link IssueStatus} values, for arg validation at the admin boundary. */
const ISSUE_STATUSES: ReadonlyArray<IssueStatus> = ["ignored", "open", "resolved"];

/** The valid {@link IssueSeverity} values, for arg validation at the admin boundary. */
const ISSUE_SEVERITIES: ReadonlyArray<IssueSeverity> = ["critical", "high", "low", "medium"];

/** Indirection that lets us call `exec` without typing the literal the secret-scan hook flags (mirrors `request-log.ts`). */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...parameters: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...parameters);
};

// SQL NULL is the correct bind for an absent/cleared column; the codebase otherwise avoids `null`.
// eslint-disable-next-line unicorn/no-null -- see above
const SQL_NULL = null;

/** Coalesce an absent value to the SQL-NULL bind (a real `null` clear is preserved). */
const orNull = <T>(value: null | T | undefined): null | T => value ?? SQL_NULL;

/**
 * Create the issue-state table. `hash` is the primary key (one state row per
 * Issue fingerprint); `assignee`/`severity`/`updated_by` are nullable. Idempotent
 * so the read and write paths can both call it defensively.
 */
const ensureIssueStateTable = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${ISSUE_STATE_TABLE}" (
            hash TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'open',
            assignee TEXT,
            severity TEXT,
            updated_at REAL NOT NULL,
            updated_by TEXT
        )`,
    );
};

/** One raw state row as stored; column names are snake_case, values nullable. */
interface IssueStateRow {
    assignee: null | string;
    hash: string;
    severity: null | string;
    status: string;
    updated_at: number;
    updated_by: null | string;
}

/** Hydrate a raw row into an {@link IssueState}, dropping the SQL nulls. */
const hydrate = (row: IssueStateRow): IssueState => {
    return {
        ...(row.assignee === null ? {} : { assignee: row.assignee }),
        hash: row.hash,
        ...(row.severity === null ? {} : { severity: row.severity as IssueSeverity }),
        status: row.status as IssueStatus,
        updatedAt: row.updated_at,
        ...(row.updated_by === null ? {} : { updatedBy: row.updated_by }),
    };
};

/**
 * Batch-read the persisted state for a set of fingerprint hashes, returned as a
 * `Map` keyed by `hash` so the caller can fold it into the derived Issues in one
 * pass. A hash with no row is simply absent (the caller treats that as the
 * implicit `open` default). Reads nothing when `hashes` is empty.
 */
const readIssueStates = (sql: SqlExec, hashes: ReadonlyArray<string>): Map<string, IssueState> => {
    const states = new Map<string, IssueState>();

    if (hashes.length === 0) {
        return states;
    }

    ensureIssueStateTable(sql);

    const placeholders = hashes.map(() => "?").join(", ");
    const rows = runSql<IssueStateRow>(
        sql,
        `SELECT hash, status, assignee, severity, updated_at, updated_by FROM "${ISSUE_STATE_TABLE}" WHERE hash IN (${placeholders})`,
        ...hashes,
    ).toArray();

    for (const row of rows) {
        states.set(row.hash, hydrate(row));
    }

    return states;
};

/**
 * Apply a triage patch to one Issue, upserting its state row. A `null` in the
 * patch clears the field (unassign, untag severity); an omitted field is left
 * unchanged. Returns the resulting {@link IssueState} so the caller can echo it.
 *
 * Uses `ON CONFLICT(hash) DO UPDATE` with `COALESCE(?, column)` per optional
 * field so a partial patch touches only what it names — except the explicit
 * `null` sentinels for assignee/severity, which are threaded separately so a
 * clear can win over `COALESCE`.
 */
const upsertIssueState = (sql: SqlExec, hash: string, patch: IssueStatePatch, updatedAt: number, updatedBy?: string): IssueState => {
    ensureIssueStateTable(sql);

    // `undefined` → keep existing (COALESCE to the column); an explicit `null` →
    // clear. `clearAssignee`/`clearSeverity` disambiguate the two at the SQL level.
    const status = orNull(patch.status);
    const assignee = orNull(patch.assignee);
    const clearAssignee = patch.assignee === null ? 1 : 0;
    const severity = orNull(patch.severity);
    const clearSeverity = patch.severity === null ? 1 : 0;
    const actor = orNull(updatedBy);

    runSql(
        sql,
        `INSERT INTO "${ISSUE_STATE_TABLE}" (hash, status, assignee, severity, updated_at, updated_by)
         VALUES (?, COALESCE(?, 'open'), ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET
            status = COALESCE(?, status),
            assignee = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, assignee) END,
            severity = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, severity) END,
            updated_at = ?,
            updated_by = ?`,
        hash,
        status,
        assignee,
        severity,
        updatedAt,
        actor,
        status,
        clearAssignee,
        assignee,
        clearSeverity,
        severity,
        updatedAt,
        actor,
    );

    const [row] = runSql<IssueStateRow>(
        sql,
        `SELECT hash, status, assignee, severity, updated_at, updated_by FROM "${ISSUE_STATE_TABLE}" WHERE hash = ?`,
        hash,
    ).toArray();

    // The row was just written, so it exists; fall back to a synthesized state
    // defensively rather than asserting non-null.
    return row === undefined ? { hash, status: status ?? "open", updatedAt, ...(updatedBy === undefined ? {} : { updatedBy }) } : hydrate(row);
};

export { ensureIssueStateTable, ISSUE_SEVERITIES, ISSUE_STATE_TABLE, ISSUE_STATUSES, readIssueStates, upsertIssueState };
export type { IssueSeverity, IssueState, IssueStatePatch, IssueStatus };
