/**
 * Storage ↔ schema correlation — the **dangling-reference** half of the file
 * browser's records↔files join (the other half, object→owning-record + per-key
 * orphan detection, lives in `findStorageReferences` in `introspect.ts`).
 *
 * Reference model: a record references a stored R2 object through a first-class
 * `v.storage(bucket?)` schema validator. Codegen emits the `{ table: [field, …] }`
 * map of those columns (`buildStorageColumns` in `@lunora/codegen`'s `emit.ts`),
 * the generated shard overrides `ShardDO.storageColumns()` with it, and both
 * correlation reads scan ONLY those declared columns — never the whole shard.
 *
 * Where `findStorageReferences` answers "given the object keys on this bucket
 * page, which rows own each?" (and flags the empty ones as orphans), this module
 * answers the inverse, which an object listing alone can't: "which record
 * storage-field values point at an object key that does NOT exist in the bucket?"
 * — a **dangling reference**. CF's R2 browser sees only the bytes and can never
 * make this join; lunora, sitting on the schema, can.
 *
 * Bounded by design: at most {@link DANGLING_SCAN_CAP} rows are scanned per
 * storage column and at most {@link DANGLING_RESULT_CAP} dangling references are
 * returned; `truncated` reports when either cap clipped the result so the studio
 * can say "showing the first N".
 *
 * The injection-safe helpers (table-existence check, double-quoting, and the
 * physical/`__doc__` column→expression resolver) are restated here rather than
 * imported so the module's SQL stays self-contained and its bound-parameter
 * discipline is auditable in one place — mirroring `introspect.ts`'s own.
 */
import type { SqlExec } from "@lunora/shard-engine";

import { jsonPathSegment } from "../../../shared/json-path-segment";
import { quoteIdentifier } from "../../../shared/quote-identifier";

/** Hard ceiling on rows scanned per storage column, so one enormous table can't make the scan unbounded. */
const DANGLING_SCAN_CAP = 5000;

/**
 * Hard ceiling on dangling references returned in one call — bounded like the mail
 * catcher caps its inbox at 500. The result reports `truncated` when this (or the
 * per-column scan cap) clipped the set so the studio can surface "first N".
 */
const DANGLING_RESULT_CAP = 500;

/** The physical doc-blob column of a canonical Lunora shard table (user fields live in `__doc__`). */
const DOC_COLUMN = "__doc__";

/** One record field whose `v.storage()` value points at an object key absent from the bucket. */
interface DanglingReference {
    /** The `v.storage()` column the dangling key was found in. */
    column: string;
    /** Primary key (`id`) of the owning row. */
    id: string;
    /** The object key the row references but which does not exist in the bucket. */
    key: string;
    /** The table the owning row lives in. */
    table: string;
}

/**
 * Result of {@link findDanglingReferences}: the dangling references discovered
 * (record fields pointing at a missing object), plus `truncated` — `true` when a
 * scan/result cap clipped the set, so the studio can log/surface that the view is
 * partial. `scanned` is the total number of non-empty storage-field values
 * examined, so the studio can show "checked N references".
 */
interface DanglingReferenceResult {
    references: DanglingReference[];
    scanned: number;
    truncated: boolean;
}

/** Tables the correlation scan must never touch (SQLite/CF/Lunora bookkeeping), mirroring `introspect.ts`'s filter. */
const isInternalTable = (name: string): boolean =>
    name.startsWith("sqlite_") || name.startsWith("_cf_") || name.startsWith("__miniflare") || name.startsWith("__lunora") || name.includes("__fts_");

/** True when `table` is a real, non-internal user table in this shard's SQLite database. */
const tableExists = (sql: SqlExec, table: string): boolean => {
    if (isInternalTable(table)) {
        return false;
    }

    return sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", table).toArray().length > 0;
};

/**
 * Resolve a declared storage column to its SQL expression plus any bound path
 * params, with the same injection-safe allowlist + bound-path discipline as
 * `introspect.ts`'s `resolveColumnExpression`. A physical column compiles to its
 * quoted identifier (no params); a `__doc__`-stored field to
 * `json_extract(__doc__, ?)` with the JSON path (`$."field"`) **bound**, never
 * interpolated. Returns `undefined` for an unknown column on a non-doc table.
 * @returns the SQL expression + bound params, or `undefined` when the column is unknown
 */
const resolveColumnExpression = (column: string, physicalColumns: string[]): undefined | { expression: string; params: unknown[] } => {
    const isPhysical = physicalColumns.includes(column);
    const isDocumentStored = physicalColumns.includes(DOC_COLUMN);

    if (!isPhysical && !isDocumentStored) {
        return undefined;
    }

    return isPhysical
        ? { expression: quoteIdentifier(column), params: [] }
        : // `jsonPathSegment`, never a hand-rolled quoter: a JSON path is not a SQL
          // identifier, so doubling `"` (the identifier rule) emits `$."a""b"`,
          // which SQLite reads as NULL instead of the column's value.
          { expression: `json_extract(${quoteIdentifier(DOC_COLUMN)}, ?)`, params: [`$.${jsonPathSegment(column)}`] };
};

/** Mutable accumulator threaded through the per-column scans so the orchestrator stays flat. */
interface DanglingAccumulator {
    references: DanglingReference[];
    scanned: number;
    truncated: boolean;
}

/**
 * Scan one declared storage column for dangling references, appending to `accumulator`.
 * Reads at most {@link DANGLING_SCAN_CAP} non-null/non-empty values, marks
 * `accumulator.truncated` when either that cap or {@link DANGLING_RESULT_CAP} fires, and
 * records every value not present in `live` (capped) as a dangling reference. The
 * column expression resolves to its physical/`__doc__` form with the same
 * injection-safe, bound-parameter discipline as `readTablePage`.
 */
const scanColumnForDangling = (
    sql: SqlExec,
    quoted: string,
    table: string,
    column: string,
    physicalColumns: string[],
    live: Set<string>,
    accumulator: DanglingAccumulator,
): void => {
    const resolved = resolveColumnExpression(column, physicalColumns);

    if (resolved === undefined) {
        return;
    }

    // Only non-null, non-empty storage values can dangle. The column expression
    // appears three times (SELECT, then both IS NOT NULL / <> guards), so its
    // bound path params are supplied three times, ahead of the LIMIT param —
    // matching the SQL textual order.
    const rows = sql
        .exec<{
            id: string;
            ref: string;
        }>(
            `SELECT id, ${resolved.expression} AS ref FROM ${quoted} WHERE ${resolved.expression} IS NOT NULL AND ${resolved.expression} <> '' LIMIT ?`,
            ...resolved.params,
            ...resolved.params,
            ...resolved.params,
            DANGLING_SCAN_CAP + 1,
        )
        .toArray();

    if (rows.length > DANGLING_SCAN_CAP) {
        accumulator.truncated = true;
    }

    for (const row of rows.slice(0, DANGLING_SCAN_CAP)) {
        accumulator.scanned += 1;

        if (live.has(row.ref)) {
            continue;
        }

        if (accumulator.references.length >= DANGLING_RESULT_CAP) {
            accumulator.truncated = true;
            continue;
        }

        accumulator.references.push({ column, id: row.id, key: row.ref, table });
    }
};

/**
 * Find every record storage-field value that points at an object key NOT present
 * in `liveKeys` — a dangling reference (the record references a file the bucket no
 * longer has). `storageColumns` is the schema-derived `{ table: [field, …] }` map
 * the codegen subclass supplies (empty for the base, schema-free DO); `liveKeys`
 * is the set of object keys that actually exist in the bucket (the caller passes
 * the enumerated bucket listing). Scans only the declared storage columns — never
 * the whole shard — and resolves each column to its physical/`__doc__` expression
 * with the same injection-safe, bound-parameter discipline as `readTablePage`.
 *
 * Bounded: at most {@link DANGLING_SCAN_CAP} rows per column are examined and at
 * most {@link DANGLING_RESULT_CAP} references returned; `truncated` flags either
 * cap firing. An empty `storageColumns` (an app that models no storage refs)
 * yields an empty, non-truncated result.
 */
const findDanglingReferences = (sql: SqlExec, storageColumns: Record<string, string[]>, liveKeys: Iterable<string>): DanglingReferenceResult => {
    const live: Set<string> = liveKeys instanceof Set ? (liveKeys as Set<string>) : new Set<string>(liveKeys);
    const accumulator: DanglingAccumulator = { references: [], scanned: 0, truncated: false };

    for (const [table, columns] of Object.entries(storageColumns)) {
        if (!tableExists(sql, table)) {
            continue;
        }

        const quoted = quoteIdentifier(table);
        const physicalColumns = sql
            .exec<{ name: string }>(`PRAGMA table_info(${quoted})`)
            .toArray()
            .map((column) => column.name);

        for (const column of columns) {
            scanColumnForDangling(sql, quoted, table, column, physicalColumns, live, accumulator);
        }
    }

    return accumulator;
};

export { DANGLING_RESULT_CAP, DANGLING_SCAN_CAP, findDanglingReferences };
export type { DanglingReference, DanglingReferenceResult };
