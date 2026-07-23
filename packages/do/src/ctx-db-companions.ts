/**
 * Companion-index maintenance, extracted from `ctx-db.ts`.
 *
 * This module owns the cohesive cluster that keeps a table's derived companion
 * indexes in step with a row write: the aggregate counters (`__agg_*`), the
 * rank companions (`__rank_*`), and the FTS5 search shadow tables. It bundles
 * the lazy first-touch backfills, the op-aware `-prev + next` deltas, and the
 * shared insert fan-out (`syncCompanionsForInsert`) that also drives CDC, the
 * reactive cache, and live-subscription broadcast.
 *
 * Behavior is byte-identical to the in-`ctx-db` original — the SQL text, the
 * call order, the backfill idempotency model (one rebuild per (table, index)
 * per ctx-db instance, run BEFORE the triggering row write), and the companion
 * semantics all sit on the hot write path and feed the same reads, so nothing
 * here may shift.
 *
 * The maintenance functions need the DO writer's locals (`sql`, `schema`, the
 * read hook, the reactive cache, the CDC recorder, the subscription broadcast).
 * Those are threaded explicitly through {@link CompanionSyncDeps} rather than
 * captured from the writer closure, so the cluster reads as a pure function of
 * its dependencies — mirroring `ctx-db-rank-page`'s `RankPageDeps`. The
 * per-(table, index) backfill bookkeeping lives inside the factory, so a fresh
 * companion-sync (one per ctx-db instance) cold-starts its backfills.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-companions" mirrors its parent "ctx-db.ts" (the established public module name); `doc`/`docs` is the domain term for a stored document throughout the DO/D1 ORM. */

import { encodeGeohash, ftsTableName, GEO_DEFAULT_PRECISION, stringifySearchText } from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

import { aggregateSqlFunction, matchesStaticWhere } from "./aggregate-sql";
import type { AggregateTally } from "./aggregate-tally";
import { aggregateTableName, coerceAggregateNumber, encodeAggregateKey, foldAggregateTally } from "./aggregate-tally";
import type { AggregateIndexDefinitionLike } from "./aggregates";
// Type-only imports for the structural surfaces the DO writer threads in — value
// imports would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SchemaLike, SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { AGG_COUNT, AGG_KEY, AGG_VALUE, aggUpsertSql, DOC_COLUMN, geoTableName, isFtsAvailable, jsonPathSql, rowToDocument, serializeSqlValue } from "./do-sql";
import { param } from "./drizzle";
import type { RankIndexDefinitionLike } from "./rank";
import { encodePartitionKey, matchesRankStaticWhere, rankTableName, sortColumnName } from "./rank";
import type { MutationDelta } from "./types";

/**
 * Whether none of the fields a rank index reads (partition / sort / static
 * `where`) differ between two row versions — the fast path that lets a patch of
 * an unrelated field skip companion maintenance.
 */
const rankIndexFieldsUnchanged = (index: RankIndexDefinitionLike, previous: Record<string, unknown>, next: Record<string, unknown>): boolean => {
    const fields = [...(index.partitionBy ?? []), ...index.sortBy.map((key) => key.field), ...(index.where ? Object.keys(index.where) : [])];

    return fields.every((field) => previous[field] === next[field]);
};

/**
 * Apply one rank index's `-prev + next` companion step for a single row write.
 * DELETE-by-id is unconditional (a missing row is a no-op); INSERT only when the
 * new row qualifies against the index's static `where`.
 */
const syncRankIndexEntry = (
    sql: SqlExec,
    tableName: string,
    index: RankIndexDefinitionLike,
    id: string,
    previous: Record<string, unknown> | undefined,
    next: Record<string, unknown> | undefined,
): void => {
    // Fast path: both sides exist and no field this index reads changed — the
    // companion entry is already correct, so skip the DELETE+INSERT pair.
    if (previous && next && rankIndexFieldsUnchanged(index, previous, next)) {
        return;
    }

    const rankTable = rankTableName(tableName, index.name);

    if (previous) {
        runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(rankTable)} WHERE ${dsql.identifier("__id__")} = ${id}`);
    }

    if (!next || (index.where && !matchesRankStaticWhere(next, index.where))) {
        // Nothing to insert: either a pure delete, or `next` doesn't qualify
        // against the index's static `where` (the prior entry, if any, is gone).
        return;
    }

    const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
    const columnsSql = dsql.join(
        ["__id__", "__partition__", ...sortColumns].map((column) => dsql.identifier(column)),
        dsql`, `,
    );
    const partitionKey = encodePartitionKey(index.partitionBy ?? [], next);
    // eslint-disable-next-line unicorn/no-null -- binds the rank sort column to SQLite: a missing sort field is a NULL column value, not undefined
    const sortValues = index.sortBy.map((key) => serializeSqlValue(next[key.field] ?? null));
    const valuesSql = dsql.join(
        [id, partitionKey, ...sortValues].map((value) => param(value)),
        dsql`, `,
    );

    runDrizzle(sql, dsql`INSERT INTO ${dsql.identifier(rankTable)} (${columnsSql}) VALUES (${valuesSql})`);
};

/**
 * The DO-writer locals the companion-maintenance cluster needs. The factory
 * (`createShardCtxDb`) builds one of these and threads it into
 * {@link createCompanionSync}, replacing what was previously closure capture so
 * the cluster is a pure function of its dependencies.
 */
interface CompanionSyncDeps {
    /** Broadcast a write delta to live (hibernated) WebSocket subscribers. */
    broadcast: (delta: MutationDelta) => void;
    /** Invalidate reactive-cache entries that read `(table, id)` / the table's scan bucket. */
    invalidateCache: (table: string, id: string) => void;
    /** Append a post-image to the CDC changelog when CDC is enabled; a no-op otherwise. */
    recordCdc: (table: string, id: string, op: "delete" | "insert" | "update", doc?: Record<string, unknown>) => void;
    /** The DO writer's schema view. */
    schema: SchemaLike;
    /** Project of `state.storage.sql` — the DO's SQLite handle. */
    sql: SqlExec;
}

/** The companion-maintenance surface the writer destructures back into its hot write path. */
interface CompanionSync {
    /** Pre-write hook: ensure every aggregate counter on `tableName` is rebuilt once per ctx-db. */
    ensureBackfilledForTable: (tableName: string) => void;
    /** Lazily (re)build a single aggregate companion the first time this ctx-db touches it. */
    ensureBackfilledIndex: (tableName: string, index: AggregateIndexDefinitionLike) => void;
    /** Lazily (re)build a single rank companion the first time this ctx-db touches it. */
    ensureRankBackfilled: (tableName: string, index: RankIndexDefinitionLike) => void;
    /** Pre-write hook: ensure every rank companion on `tableName` is rebuilt once per ctx-db. */
    ensureRankBackfilledForTable: (tableName: string) => void;
    /** Post-write hook: apply the `-prev + next` step for every declared aggregate index. */
    syncAggregates: (tableName: string, previous: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined) => void;
    /** Post-write companion maintenance shared by the single + bulk insert paths. */
    syncCompanionsForInsert: (tableName: string, id: string, document: Record<string, unknown>) => void;
    /** Keep the geohash companion tables in step with a row write (no-op without geo indexes). */
    syncGeo: (tableName: string, id: string, document: Record<string, unknown> | undefined) => void;
    /** Post-write hook: apply the `-prev + next` step for every declared rank index. */
    syncRanks: (tableName: string, id: string, previous: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined) => void;
    /** Keep the FTS5 shadow tables in step with a row write (no-op without search indexes / FTS5). */
    syncSearch: (tableName: string, id: string, document: Record<string, unknown> | undefined) => void;
}

/**
 * Build the companion-index maintenance cluster bound to one ctx-db instance.
 * The returned functions keep the aggregate, rank, and FTS companions in step
 * with the writer's row writes; both the write path and the aggregate/rank read
 * fast-paths share the returned backfill helpers, so the per-(table, index)
 * backfill set held here is the single "rebuilt this instance?" source of truth.
 */
const createCompanionSync = (deps: CompanionSyncDeps): CompanionSync => {
    const { broadcast, invalidateCache, recordCdc, schema, sql } = deps;

    // Tracks which (table, aggregateIndex) pairs this ctx-db has already rebuilt
    // so the lazy backfill runs exactly once per index per ctx-db instance.
    const backfilled = new Set<string>();
    // Same bookkeeping for rank companions.
    const rankBackfilled = new Set<string>();

    /**
     * Lazily (re)build an aggregate companion the first time this ctx-db
     * touches it. Idempotency model: each ctx-db tracks which (table, index)
     * pairs it has already considered; the first touch (read or write) does a
     * full rebuild from scratch — TRUNCATE then re-tally — so that an index
     * declared after rows already existed (the "added to an existing schema"
     * case) heals on first use. Subsequent touches in the same ctx-db skip the
     * rebuild and trust the trigger-maintained deltas.
     *
     * Must run **before** the triggering row write — otherwise the rebuild
     * would double-count the row that's about to be stepped.
     */
    const ensureBackfilledIndex = (tableName: string, index: AggregateIndexDefinitionLike): void => {
        const cacheKey = `${tableName}::${index.name}`;

        if (backfilled.has(cacheKey)) {
            return;
        }

        const aggTable = aggregateTableName(tableName, index.name);
        const by = index.by ?? [];
        const tallies = new Map<string, AggregateTally>();
        const rows = runDrizzle(sql, dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`).toArray();

        for (const row of rows) {
            const record = rowToDocument(row);

            if (!record) {
                continue;
            }

            if (index.where && !matchesStaticWhere(record, index.where)) {
                continue;
            }

            const encoded = encodeAggregateKey(by, record);

            foldAggregateTally(tallies, encoded, index, record);
        }

        runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(aggTable)}`);

        const CHUNK_ROWS = 32; // 3 params/row → 96 bound params, under SQLite's per-statement cap
        const entries = [...tallies];

        for (let start = 0; start < entries.length; start += CHUNK_ROWS) {
            const chunk = entries.slice(start, start + CHUNK_ROWS);
            const rowsSql = dsql.join(
                chunk.map(([encoded, tally]) => dsql`(${encoded}, ${tally.value}, ${tally.count})`),
                dsql`, `,
            );

            runDrizzle(sql, dsql`INSERT INTO ${dsql.identifier(aggTable)} (${AGG_KEY}, ${AGG_VALUE}, ${AGG_COUNT}) VALUES ${rowsSql}`);
        }

        backfilled.add(cacheKey);
    };

    /**
     * Recompute a min/max group's stored extreme from the source table, scoped
     * to the group's `by`-tuple and the index's static `where`. Used on the slow
     * path when the removed/old value *was* the stored extreme (so we can't tell
     * the new extreme without looking): a single `MIN`/`MAX(json_extract(...))`
     * over the group answers it. Runs AFTER the physical row write, so it sees
     * the post-write source. Returns the extreme (`null` when no numeric row
     * survives); the caller pins `__count__` from its own tracked tally.
     */
    const recomputeExtreme = (tableName: string, index: AggregateIndexDefinitionLike, record: Record<string, unknown>): { value: null | number } => {
        const by = index.by ?? [];
        const sqlFunction = aggregateSqlFunction(index.op);
        const field = index.field ?? "";
        const conditions: SQL[] = [];

        for (const key of by) {
            // eslint-disable-next-line unicorn/no-null -- canonical key tuple: a missing by-field is matched as NULL, mirroring encodeAggregateKey's null-fill
            const value = serializeSqlValue(record[key] ?? null);

            if (value === null) {
                conditions.push(dsql`${jsonPathSql(key)} IS NULL`);
            } else {
                conditions.push(dsql`${jsonPathSql(key)} = ${value}`);
            }
        }

        for (const [key, expected] of Object.entries(index.where ?? {})) {
            const literal = expected !== null && typeof expected === "object" && !Array.isArray(expected) ? (expected as { eq: unknown }).eq : expected;
            const value = serializeSqlValue(literal);

            if (value === null) {
                conditions.push(dsql`${jsonPathSql(key)} IS NULL`);
            } else {
                conditions.push(dsql`${jsonPathSql(key)} = ${value}`);
            }
        }

        const whereSql = conditions.length > 0 ? dsql` WHERE ${dsql.join(conditions, dsql` AND `)}` : dsql``;
        const ref = jsonPathSql(field);
        const row = runDrizzle<{ value: null | number }>(
            sql,
            dsql`SELECT ${dsql.raw(sqlFunction)}(${ref}) AS value FROM ${dsql.identifier(tableName)}${whereSql}`,
        ).one();

        // eslint-disable-next-line unicorn/no-null -- empty min/max group stores NULL value
        return { value: row.value ?? null };
    };

    /**
     * Op-aware companion maintenance for a single index. `previous`/`next` are
     * the row's pre/post images (either may be absent for delete/insert); a
     * patch passes both. The contribution of a row to its group depends on the
     * index `op`, and the row only contributes when it passes the index's static
     * `where`:
     *
     * - **count**: `__value__` and `__count__` both move by ±1 (value mirrors count).
     * - **sum**: `__value__` += ±field, `__count__` += ±1 (numeric rows only).
     * - **avg**: `__value__` accumulates the running sum, `__count__` the divisor; the reader divides. Same ±field/±1 steps as sum.
     * - **min/max**: `__count__` += ±1. The extreme is bumped cheaply on the +side (a new value more extreme than the stored one wins, or seeds an empty group); when a removed/old value *was* the stored extreme — or the group empties — we recompute from the source table.
     *
     * An update is decomposed into remove-old then add-new, so the same code
     * path handles the by-key/field-value change that a patch/replace can cause.
     */
    /* eslint-disable sonarjs/cognitive-complexity -- op-aware (count/sum/avg/min/max) maintenance over remove-old + add-new branches; splitting it would scatter the single companion-row update across helpers and read worse */
    const applyAggregateDelta = (
        tableName: string,
        index: AggregateIndexDefinitionLike,
        previous: Record<string, unknown> | undefined,
        next: Record<string, unknown> | undefined,
    ): void => {
        const aggTable = aggregateTableName(tableName, index.name);
        const { op } = index;
        const field = index.field ?? "";

        // Drop a companion row once its group is empty (`__count__` hit 0) so the
        // indexed groupBy walk matches SQL `GROUP BY`, which omits empty groups —
        // a left-behind zeroed/NULL row would surface as a phantom group.
        const pruneIfEmpty = (encodedKey: string): void => {
            runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(aggTable)} WHERE ${AGG_KEY} = ${encodedKey} AND ${AGG_COUNT} <= 0`);
        };

        const removes = previous && (!index.where || matchesStaticWhere(previous, index.where)) ? previous : undefined;
        const adds = next && (!index.where || matchesStaticWhere(next, index.where)) ? next : undefined;

        if (!removes && !adds) {
            return;
        }

        if (op === "count") {
            // The +1/−1 steps can collapse to a single delta per group.
            for (const [record, delta] of [
                [removes, -1],
                [adds, 1],
            ] as const) {
                if (!record) {
                    continue;
                }

                const encoded = encodeAggregateKey(index.by ?? [], record);

                runDrizzle(
                    sql,
                    aggUpsertSql(
                        aggTable,
                        encoded,
                        delta,
                        delta,
                        dsql`${AGG_VALUE} = ${AGG_VALUE} + excluded.${AGG_VALUE}, ${AGG_COUNT} = ${AGG_COUNT} + excluded.${AGG_COUNT}`,
                    ),
                );
            }

            if (removes) {
                pruneIfEmpty(encodeAggregateKey(index.by ?? [], removes));
            }

            return;
        }

        if (op === "sum" || op === "avg") {
            for (const [record, sign] of [
                [removes, -1],
                [adds, 1],
            ] as const) {
                if (!record) {
                    continue;
                }

                const numeric = coerceAggregateNumber(record[field]);

                if (numeric === undefined) {
                    continue;
                }

                const encoded = encodeAggregateKey(index.by ?? [], record);

                runDrizzle(
                    sql,
                    aggUpsertSql(
                        aggTable,
                        encoded,
                        sign * numeric,
                        sign,
                        dsql`${AGG_VALUE} = COALESCE(${AGG_VALUE}, 0) + excluded.${AGG_VALUE}, ${AGG_COUNT} = ${AGG_COUNT} + excluded.${AGG_COUNT}`,
                    ),
                );
            }

            if (removes) {
                pruneIfEmpty(encodeAggregateKey(index.by ?? [], removes));
            }

            return;
        }

        // min/max: maintain `__count__` always; bump `__value__` cheaply on the
        // add side, recompute on the remove side when the stored extreme leaves.
        if (removes) {
            const encoded = encodeAggregateKey(index.by ?? [], removes);
            const removedValue = coerceAggregateNumber(removes[field]);
            const existing = runDrizzle<{ count: number; value: null | number }>(
                sql,
                dsql`SELECT ${AGG_VALUE} AS value, ${AGG_COUNT} AS count FROM ${dsql.identifier(aggTable)} WHERE ${AGG_KEY} = ${encoded}`,
            ).toArray()[0];
            const remainingCount = (existing?.count ?? 0) - 1;

            if (remainingCount <= 0) {
                // Group emptied — drop the companion row so the indexed groupBy
                // walk matches SQL `GROUP BY` (which omits empty groups).
                runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(aggTable)} WHERE ${AGG_KEY} = ${encoded}`);
            } else if (existing && removedValue !== undefined && existing.value !== null && removedValue === existing.value) {
                // The departing row carried the stored extreme, so we can't keep
                // it without looking — recompute the group's extreme from the
                // source table. Companion maintenance runs AFTER the physical
                // row write (the row is gone on delete; on a shrinking update the
                // source already holds the new value), so the recompute sees the
                // post-write state and returns the correct surviving extreme. We
                // still pin `__count__` to the tracked `remainingCount` rather
                // than the recompute (which counts numeric `field`s, not rows).
                const recomputed = recomputeExtreme(tableName, index, removes);

                runDrizzle(
                    sql,
                    dsql`UPDATE ${dsql.identifier(aggTable)} SET ${AGG_VALUE} = ${recomputed.value}, ${AGG_COUNT} = ${remainingCount} WHERE ${AGG_KEY} = ${encoded}`,
                );
            } else {
                // The departing row wasn't the extreme — the stored value stands.
                runDrizzle(sql, dsql`UPDATE ${dsql.identifier(aggTable)} SET ${AGG_COUNT} = ${AGG_COUNT} - 1 WHERE ${AGG_KEY} = ${encoded}`);
            }
        }

        if (adds) {
            const encoded = encodeAggregateKey(index.by ?? [], adds);
            const addedValue = coerceAggregateNumber(adds[field]);

            // A non-numeric value contributes nothing to the extreme but still
            // counts toward the group (so an empty-group check stays accurate).
            if (addedValue === undefined) {
                runDrizzle(
                    sql,
                    // eslint-disable-next-line unicorn/no-null -- seeds an extreme-less group with NULL value
                    aggUpsertSql(aggTable, encoded, null, 1, dsql`${AGG_COUNT} = ${AGG_COUNT} + 1`),
                );
            } else {
                const op2 = op === "min" ? "MIN" : "MAX";

                runDrizzle(
                    sql,
                    aggUpsertSql(
                        aggTable,
                        encoded,
                        addedValue,
                        1,
                        dsql`${AGG_VALUE} = ${dsql.raw(op2)}(COALESCE(${AGG_VALUE}, excluded.${AGG_VALUE}), excluded.${AGG_VALUE}), ${AGG_COUNT} = ${AGG_COUNT} + 1`,
                    ),
                );
            }
        }
    };
    /* eslint-enable sonarjs/cognitive-complexity */

    /**
     * Pre-write hook: ensure every aggregate counter on `tableName` is rebuilt
     * once per ctx-db instance. The rebuild scans the live source table, so
     * callers MUST invoke this before the row write — otherwise the new row
     * lands in both the rebuild and the `+1` step that follows.
     */
    const ensureBackfilledForTable = (tableName: string): void => {
        const indexes = schema.tables[tableName]?.aggregateIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            ensureBackfilledIndex(tableName, index);
        }
    };

    /**
     * Post-write hook: apply the `-prev + next` step for every declared
     * aggregate index. Must be paired with a `ensureBackfilledForTable` call
     * earlier in the same write so the counter is in step with the source.
     */
    const syncAggregates = (tableName: string, previous: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined): void => {
        const indexes = schema.tables[tableName]?.aggregateIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            applyAggregateDelta(tableName, index, previous, next);
        }
    };

    /**
     * Lazily rebuild a rank companion the first time the ctx-db instance
     * touches it. TRUNCATE then re-insert so a rankIndex declared after rows
     * already existed heals on first use. Must run BEFORE the triggering row
     * write, same reasoning as the aggregate backfill.
     */
    const ensureRankBackfilled = (tableName: string, index: RankIndexDefinitionLike): void => {
        const cacheKey = `${tableName}::rank::${index.name}`;

        if (rankBackfilled.has(cacheKey)) {
            return;
        }

        const rankTable = rankTableName(tableName, index.name);
        const rows = runDrizzle(sql, dsql`SELECT id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(tableName)}`).toArray();

        runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(rankTable)}`);

        const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
        const columnsSql = dsql.join(
            ["__id__", "__partition__", ...sortColumns].map((column) => dsql.identifier(column)),
            dsql`, `,
        );

        for (const row of rows) {
            const record = rowToDocument(row);

            if (!record) {
                continue;
            }

            if (index.where && !matchesRankStaticWhere(record, index.where)) {
                continue;
            }

            const partitionKey = encodePartitionKey(index.partitionBy ?? [], record);
            // eslint-disable-next-line unicorn/no-null -- binds the rank sort column to SQLite: a missing sort field is a NULL column value, not undefined
            const sortValues = index.sortBy.map((key) => serializeSqlValue(record[key.field] ?? null));
            const valuesSql = dsql.join(
                [record["_id"] as string, partitionKey, ...sortValues].map((value) => param(value)),
                dsql`, `,
            );

            runDrizzle(sql, dsql`INSERT INTO ${dsql.identifier(rankTable)} (${columnsSql}) VALUES (${valuesSql})`);
        }

        rankBackfilled.add(cacheKey);
    };

    /** Pre-write hook: ensure every rank companion on `tableName` is rebuilt once per ctx-db. */
    const ensureRankBackfilledForTable = (tableName: string): void => {
        const indexes = schema.tables[tableName]?.rankIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            ensureRankBackfilled(tableName, index);
        }
    };

    /**
     * Apply a `-prev + next` step for every declared rank index, atomic with
     * the row write within the DO transaction. `delete` calls this with
     * `next === undefined`; `insert` with `previous === undefined`. The
     * companion is keyed by source row id so we just DELETE+INSERT instead of
     * trying to UPDATE in place — keeps the maintenance idempotent.
     */
    const syncRanks = (tableName: string, id: string, previous: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined): void => {
        const indexes = schema.tables[tableName]?.rankIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            syncRankIndexEntry(sql, tableName, index, id, previous, next);
        }
    };

    /**
     * Keep the FTS5 shadow tables in step with a row write. A no-op when the
     * table declares no search indexes or when FTS5 is unavailable (the scan
     * fallback reads the live document table, so nothing to mirror). Delete then
     * insert makes it idempotent across insert/update; `doc === undefined`
     * deletes only (row removal).
     */
    const syncSearch = (tableName: string, id: string, document: Record<string, unknown> | undefined): void => {
        const indexes = schema.tables[tableName]?.searchIndexes;

        if (!indexes || indexes.length === 0 || !isFtsAvailable(sql)) {
            return;
        }

        for (const index of indexes) {
            const ftName = ftsTableName(tableName, index.name);

            runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(ftName)} WHERE ${dsql.identifier("__id__")} = ${id}`);

            if (document) {
                runDrizzle(
                    sql,
                    dsql`INSERT INTO ${dsql.identifier(ftName)} (${dsql.identifier("__text__")}, ${dsql.identifier("__id__")}) VALUES (${stringifySearchText(document[index.field])}, ${id})`,
                );
            }
        }
    };

    /**
     * Keep the geohash companion tables in step with a row write. A no-op when
     * the table declares no geo indexes. Delete then insert makes it idempotent
     * across insert/update; `document === undefined` (or a missing/invalid point)
     * deletes only. The raw `lat`/`lng` are stored beside the geohash so the
     * reader can Haversine-refine without re-decoding the source doc.
     */
    const syncGeo = (tableName: string, id: string, document: Record<string, unknown> | undefined): void => {
        const indexes = schema.tables[tableName]?.geoIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            const geoTable = geoTableName(tableName, index.name);

            runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(geoTable)} WHERE ${dsql.identifier("__id__")} = ${id}`);

            const point = document?.[index.field];

            if (
                point !== null &&
                typeof point === "object" &&
                typeof (point as { lat?: unknown }).lat === "number" &&
                typeof (point as { lng?: unknown }).lng === "number"
            ) {
                const { lat, lng } = point as { lat: number; lng: number };
                const hash = encodeGeohash({ lat, lng }, index.precision ?? GEO_DEFAULT_PRECISION);

                runDrizzle(
                    sql,
                    dsql`INSERT INTO ${dsql.identifier(geoTable)} (${dsql.identifier("__id__")}, ${dsql.identifier("__geohash__")}, ${dsql.identifier("__lat__")}, ${dsql.identifier("__lng__")}) VALUES (${id}, ${hash}, ${lat}, ${lng})`,
                );
            }
        }
    };

    /**
     * Post-write companion maintenance shared by the insert paths — the single
     * `insert` and the `insertManyUnsafe` bulk loop run the identical fan-out, so
     * it lives here once: keep the search/aggregate/rank indexes, the CDC log, the
     * reactive cache and live subscriptions in step with a freshly-written row.
     * (The callers still own their own `after`-trigger + `onWrite` step, which
     * differ — `insertManyUnsafe` skips triggers.) Invalidate runs BEFORE the
     * broadcast so a subscriber re-running its query can't read a stale cache
     * entry; `invalidate(table, id)` clears both the per-id and the `table:*scan`
     * bucket (an insert can flip any scan-shaped result).
     */
    const syncCompanionsForInsert = (tableName: string, id: string, document: Record<string, unknown>): void => {
        syncSearch(tableName, id, document);
        syncGeo(tableName, id, document);
        syncAggregates(tableName, undefined, document);
        syncRanks(tableName, id, undefined, document);
        invalidateCache(tableName, id);
        recordCdc(tableName, id, "insert", document);
        broadcast({ key: id, op: "insert", row: document, table: tableName });
    };

    return {
        ensureBackfilledForTable,
        ensureBackfilledIndex,
        ensureRankBackfilled,
        ensureRankBackfilledForTable,
        syncAggregates,
        syncCompanionsForInsert,
        syncGeo,
        syncRanks,
        syncSearch,
    };
};

export { createCompanionSync };
export type { CompanionSync, CompanionSyncDeps };
