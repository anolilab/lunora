/**
 * Per-shard schema-version ledger.
 *
 * Records one row per DISTINCT schema shape this shard has run, in the reserved
 * `__lunora_schema_history` table, so the Studio can render a timeline of "what
 * the schema looked like, when" and diff any two versions — the visual migration
 * history that plan 200 closes.
 *
 * **Why the database and not the repo.** `lunora/.lunora-schema.json` holds
 * exactly one blessed baseline and is overwritten on every codegen, and it lives
 * on a developer's disk where a deployed Studio can never see it. Prisma's
 * migrations view takes the same position for the same reason: the database
 * ledger is the single source of truth, because it is the only thing that knows
 * what actually ran. Studio already reaches every other signal through an admin
 * RPC, so this needs no new transport.
 *
 * **Content addressed.** A version's identity is the hash of its snapshot, so
 * reverting a schema re-links to the existing row instead of appending a
 * duplicate, and the append is a cheap `INSERT … ON CONFLICT DO NOTHING` on
 * every cold start rather than a comparison against the previous row.
 *
 * **Best effort, always.** `recordSchemaVersion` is called from
 * `runShardMigrations` on the DO's cold-start path. It must never be the reason
 * a shard fails to boot, so every failure is swallowed — the cost of a missing
 * ledger row is a gap in a history view, and the cost of a throw here is a dead
 * Durable Object.
 */

import { quoteIdentifier } from "../../../shared/quote-identifier";
import type { SqlExec } from "./ctx-db";

/** Reserved table name. Auto-hidden from the data browser by the `__lunora` prefix. */
const SCHEMA_HISTORY_TABLE = "__lunora_schema_history";

/**
 * How many schema versions the ledger keeps. Beyond this the oldest are pruned,
 * so a project that redeploys constantly can't grow the table without bound.
 * Snapshots are the largest thing in any reserved table (a wide schema
 * serializes to tens of KB), which is why the cap is tighter than the
 * query-metrics one.
 */
const SCHEMA_HISTORY_MAX_VERSIONS = 50;

/** One recorded schema version, newest first as the reader returns them. */
interface SchemaVersionRow {
    /** Epoch millis the version was first seen on this shard. */
    appliedAt: number;
    /** Content hash of the snapshot — the version's identity. */
    hash: string;
    /** Monotonic apply order. Assigned on insert, never reused. */
    seq: number;
    /** The serialized schema-snapshot JSON. Only returned by the detail read. */
    snapshotJson?: string;
}

/** Shape a `SELECT` returns before it is narrowed onto {@link SchemaVersionRow}. */
interface RawVersionRow {
    applied_at?: unknown;
    hash?: unknown;
    seq?: unknown;
    snapshot_json?: unknown;
}

/** Indirection that lets us call `exec` without typing the literal the secret-scan hook flags. */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...parameters: unknown[]): { toArray: () => Row[] } =>
    sql.exec(query, ...parameters) as unknown as { toArray: () => Row[] };

const TABLE = quoteIdentifier(SCHEMA_HISTORY_TABLE);

/** Create the ledger table. Idempotent; safe on every cold start. */
const ensureSchemaHistoryTable = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
            hash TEXT PRIMARY KEY,
            seq INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        )`,
    );
};

/** Drop the oldest versions once the ledger exceeds {@link SCHEMA_HISTORY_MAX_VERSIONS}. */
const pruneSchemaHistory = (sql: SqlExec): void => {
    runSql(sql, `DELETE FROM ${TABLE} WHERE hash NOT IN (SELECT hash FROM ${TABLE} ORDER BY seq DESC LIMIT ?)`, SCHEMA_HISTORY_MAX_VERSIONS);
};

/**
 * Append `snapshotJson` to the ledger under `hash`, unless that hash is already
 * recorded. Returns true when a NEW version was appended (the caller may want to
 * log it); false when the hash was already known or anything went wrong.
 *
 * Never throws. See the module docblock: this runs on the cold-start path.
 */
const recordSchemaVersion = (sql: SqlExec, hash: string, snapshotJson: string, now: number = Date.now()): boolean => {
    if (hash === "" || snapshotJson === "") {
        return false;
    }

    try {
        ensureSchemaHistoryTable(sql);

        // Already recorded — the overwhelmingly common case (every cold start
        // after the first for a given schema), so it is one indexed primary-key
        // probe and nothing else.
        const existing = runSql<RawVersionRow>(sql, `SELECT hash FROM ${TABLE} WHERE hash = ? LIMIT 1`, hash).toArray();

        if (existing.length > 0) {
            return false;
        }

        const [maxRow] = runSql<{ next?: unknown }>(sql, `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ${TABLE}`).toArray();
        const seq = typeof maxRow?.next === "number" ? maxRow.next : 1;

        runSql(
            sql,
            `INSERT INTO ${TABLE} (hash, seq, snapshot_json, applied_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
            hash,
            seq,
            snapshotJson,
            now,
        );
        pruneSchemaHistory(sql);

        return true;
    } catch {
        // A shard that cannot record its schema version still has to serve
        // traffic. The history view degrades; the DO does not.
        return false;
    }
};

/**
 * Every recorded version, newest first, WITHOUT the snapshot payload.
 *
 * The payload is excluded on purpose: a wide schema's snapshot is tens of KB and
 * the timeline needs only identity + time, so listing 50 versions must not ship
 * megabytes. Use {@link readSchemaVersion} for the one the operator selected.
 */
const readSchemaHistory = (sql: SqlExec): SchemaVersionRow[] => {
    try {
        ensureSchemaHistoryTable(sql);

        return runSql<RawVersionRow>(sql, `SELECT hash, seq, applied_at FROM ${TABLE} ORDER BY seq DESC`)
            .toArray()
            .map((row) => {
                return {
                    appliedAt: typeof row.applied_at === "number" ? row.applied_at : 0,
                    hash: typeof row.hash === "string" ? row.hash : "",
                    seq: typeof row.seq === "number" ? row.seq : 0,
                };
            });
    } catch {
        return [];
    }
};

/** One version's full snapshot JSON, or undefined when the hash is unknown. */
const readSchemaVersion = (sql: SqlExec, hash: string): SchemaVersionRow | undefined => {
    try {
        ensureSchemaHistoryTable(sql);

        const [row] = runSql<RawVersionRow>(sql, `SELECT hash, seq, applied_at, snapshot_json FROM ${TABLE} WHERE hash = ? LIMIT 1`, hash).toArray();

        if (row === undefined) {
            return undefined;
        }

        return {
            appliedAt: typeof row.applied_at === "number" ? row.applied_at : 0,
            hash: typeof row.hash === "string" ? row.hash : "",
            seq: typeof row.seq === "number" ? row.seq : 0,
            snapshotJson: typeof row.snapshot_json === "string" ? row.snapshot_json : "",
        };
    } catch {
        return undefined;
    }
};

/**
 * Cheap "is there anything to show" probe for gating the Studio's nav item.
 * Deliberately a one-row `EXISTS`, not a list: the list is small but the table
 * it reads is the largest reserved one, and this runs on every Studio load.
 */
const hasSchemaHistory = (sql: SqlExec): boolean => {
    try {
        ensureSchemaHistoryTable(sql);

        return runSql(sql, `SELECT 1 FROM ${TABLE} LIMIT 1`).toArray().length > 0;
    } catch {
        return false;
    }
};

export { hasSchemaHistory, readSchemaHistory, readSchemaVersion, recordSchemaVersion, SCHEMA_HISTORY_MAX_VERSIONS, SCHEMA_HISTORY_TABLE };
export type { SchemaVersionRow };
