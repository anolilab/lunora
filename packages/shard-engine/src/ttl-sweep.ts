/**
 * Declarative table-level TTL sweep (`.ttl(field, { after })`).
 *
 * A table's TTL policy names an epoch-millisecond column whose value (optionally
 * offset by `after`) is the row's expiry instant. The DO alarm periodically calls
 * {@link selectExpiredIds} to page the expired rows, then removes each THROUGH the
 * schema-aware writer (`runShardWrite`) so companions/CDC/subscriptions
 * stay correct and a `.softDelete()` table soft-deletes (flips the marker) rather
 * than physically removing the row. On a soft-delete table already-deleted rows
 * are excluded from the scan so the sweep doesn't re-process tombstones.
 */

import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { jsonPathSql } from "./do-sql";

/** One table's resolved TTL policy, as surfaced to the DO alarm by the generated shard subclass. */
export interface TtlSweepSpec {
    /** Millisecond offset added to `field` to derive the expiry (`field + after`); absent ⇒ `field` is the absolute expiry. */
    after?: number;
    /** The epoch-millisecond expiry column. */
    field: string;
    /** The `.softDelete()` marker column, when the table soft-deletes — expired-but-already-tombstoned rows are skipped. */
    softDeleteField?: string;
    /** The table whose expired rows are swept. */
    table: string;
}

/**
 * Select up to `limit` ids of rows in `spec.table` whose TTL expired at `now`
 * (i.e. `field + (after ?? 0) < now`). `hasMore` is `true` when matches remained
 * beyond `limit`, so the caller can loop a bounded batch. When `spec.softDeleteField`
 * is set, rows already soft-deleted (marker non-null) are excluded so the sweep
 * never re-touches a tombstone.
 */
export const selectExpiredIds = (sql: SqlExec, spec: TtlSweepSpec, now: number, limit: number): { hasMore: boolean; ids: string[] } => {
    const cutoff = now - (spec.after ?? 0);
    const conditions = [dsql`${jsonPathSql(spec.field)} IS NOT NULL`, dsql`${jsonPathSql(spec.field)} < ${cutoff}`];

    if (spec.softDeleteField !== undefined) {
        conditions.push(dsql`${jsonPathSql(spec.softDeleteField)} IS NULL`);
    }

    const query = dsql`SELECT id FROM ${dsql.identifier(spec.table)} WHERE ${dsql.join(conditions, dsql` AND `)} LIMIT ${dsql.raw(String(Math.max(0, Math.floor(limit)) + 1))}`;
    const rows = runDrizzle<{ id: string }>(sql, query).toArray();
    const hasMore = rows.length > limit;
    const ids = rows.slice(0, limit).map((row) => row.id);

    return { hasMore, ids };
};

/**
 * The column list of a TTL table's expression index, built from the same
 * {@link jsonPathSql} the sweep's WHERE uses so SQLite matches the two. A
 * soft-delete table leads with its marker: `marker IS NULL` is then an equality
 * prefix, and neither the sweep nor {@link nextTtlExpiry} walks tombstones.
 */
export const ttlIndexColumns = (field: string, softDeleteField: string | undefined): SQL =>
    softDeleteField === undefined ? jsonPathSql(field) : dsql`${jsonPathSql(softDeleteField)}, ${jsonPathSql(field)}`;

/**
 * The earliest expiry instant (`field + after`) among `spec.table`'s live rows,
 * or `undefined` when no row carries a numeric TTL. A non-numeric value never
 * satisfies the sweep's `< cutoff`, so it never expires and is not reported.
 */
export const nextTtlExpiry = (sql: SqlExec, spec: TtlSweepSpec): number | undefined => {
    const live = spec.softDeleteField === undefined ? dsql`` : dsql` WHERE ${jsonPathSql(spec.softDeleteField)} IS NULL`;
    const query = dsql`SELECT MIN(${jsonPathSql(spec.field)}) AS expiry FROM ${dsql.identifier(spec.table)}${live}`;
    const expiry = runDrizzle<{ expiry: unknown }>(sql, query).toArray()[0]?.expiry;

    return typeof expiry === "number" ? expiry + (spec.after ?? 0) : undefined;
};
