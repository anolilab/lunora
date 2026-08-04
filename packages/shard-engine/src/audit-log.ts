/**
 * Per-shard durable audit log.
 *
 * A reserved, append-only table that records admin state-changing operations
 * (`writeRow`, `runMigration`, `importShard`, `applyCdc`) so an operator can
 * answer "who changed what, when" after the fact. Modelled on the CDC-log
 * helpers in `ctx-db.ts` (`migrateCdcLog`/`appendCdcChange`/`readCdcChanges`/
 * `trimCdcChanges`) and the reserved-table pattern in `data-migration.ts`
 * (`ensureStateTable`).
 *
 * Unlike CDC — which captures every committed row mutation for streaming-export
 * and PITR — the audit log captures only the handful of admin RPCs that mutate
 * state, each annotated with the acting user. Retention is bounded to the most
 * recent `AUDIT_LOG_RETENTION` rows, so the log can't grow unbounded.
 */

import type { SqlExec } from "./ctx-db";
import { runSql } from "./do-exec";

/** Reserved append-only table backing the studio Audit tab. Auto-hidden from the data browser by the `__lunora` prefix. */
const AUDIT_LOG_TABLE = "__lunora_audit__";

/** Most recent entries kept; older rows are trimmed after each append so the log stays bounded. */
const AUDIT_LOG_RETENTION = 1000;

/** One recorded admin operation, in monotonic `seq` order. */
interface AuditEntry {
    /** JSON-decoded extra context (the acting user, op-specific counts, …); absent when none was recorded. */
    detail?: Record<string, unknown>;
    /** Primary key of the affected row, when the op targets one. */
    id?: string;
    /** Short op identifier, e.g. `writeRow` or `runMigration`. */
    op: string;
    /** Monotonic per-shard cursor — strictly increasing, never reused. */
    seq: number;
    /** Affected table, when the op targets one. */
    table?: string;
    /** Wall-clock millis when the op was recorded. */
    ts: number;
}

/** Fields accepted when appending one audit entry; `seq` is assigned by the table. */
interface AppendAuditEntry {
    detail?: Record<string, unknown>;
    id?: string;
    op: string;
    table?: string;
    ts: number;
}

/**
 * Create the `__lunora_audit__` table. `seq` is an `AUTOINCREMENT` primary key,
 * giving each shard a monotonic cursor the Audit tab pages through; `detail`
 * holds JSON extra context and is `NULL` when none was recorded. Idempotent, so
 * read and write paths can call it defensively.
 */
const ensureAuditTable = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${AUDIT_LOG_TABLE}" (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            op TEXT NOT NULL,
            "table" TEXT,
            id TEXT,
            detail TEXT
        )`,
    );
};

/**
 * Append one admin op to the audit log, then trim the log back to the most
 * recent `AUDIT_LOG_RETENTION` rows. Creates the table first so callers needn't.
 */
const appendAuditEntry = (sql: SqlExec, entry: AppendAuditEntry): void => {
    ensureAuditTable(sql);

    runSql(
        sql,
        `INSERT INTO "${AUDIT_LOG_TABLE}" (ts, op, "table", id, detail) VALUES (?, ?, ?, ?, ?)`,
        entry.ts,
        entry.op,
        // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct value for an op with no associated table/id/detail.
        entry.table ?? null,
        // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct value for an op with no associated table/id/detail.
        entry.id ?? null,
        // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct value for an op with no associated table/id/detail.
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
    );

    // Bounded retention: drop every row older than the most recent
    // `AUDIT_LOG_RETENTION` by `seq`, mirroring `trimCdcChanges`.
    runSql(sql, `DELETE FROM "${AUDIT_LOG_TABLE}" WHERE seq <= (SELECT MAX(seq) - ? FROM "${AUDIT_LOG_TABLE}")`, AUDIT_LOG_RETENTION);
};

/**
 * Read audit entries newest-first, optionally only those after `sinceSeq`, up to
 * `limit` (clamped to [1, 10000]). Parses each row's `detail` JSON back into an
 * object. Creates the table first so reads on a never-audited shard return `[]`
 * instead of throwing. Mirrors `readCdcChanges`.
 */
const readAuditLog = (sql: SqlExec, options: { limit?: number; sinceSeq?: number } = {}): AuditEntry[] => {
    ensureAuditTable(sql);

    const sinceSeq = options.sinceSeq ?? 0;
    const limit = Math.max(1, Math.min(options.limit ?? AUDIT_LOG_RETENTION, 10_000));

    const rows = runSql<{ detail: null | string; id: null | string; op: string; seq: number; table: null | string; ts: number }>(
        sql,
        `SELECT seq, ts, op, "table", id, detail FROM "${AUDIT_LOG_TABLE}" WHERE seq > ? ORDER BY seq DESC LIMIT ?`,
        sinceSeq,
        limit,
    ).toArray();

    return rows.map((row): AuditEntry => {
        const base: AuditEntry = { op: row.op, seq: row.seq, ts: row.ts };

        if (row.table !== null) {
            base.table = row.table;
        }

        if (row.id !== null) {
            base.id = row.id;
        }

        if (row.detail !== null) {
            base.detail = JSON.parse(row.detail) as Record<string, unknown>;
        }

        return base;
    });
};

export { appendAuditEntry, AUDIT_LOG_TABLE, ensureAuditTable, readAuditLog };
export type { AppendAuditEntry, AuditEntry };
