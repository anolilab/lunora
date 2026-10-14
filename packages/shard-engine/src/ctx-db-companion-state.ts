/**
 * Durable rebuild markers for the DO store's aggregate (`__agg_*`) and rank
 * (`__rank_*`) companions.
 *
 * A companion is derived from its source table: one full scan rebuilds it, and
 * from then on every row write steps it with a `-prev + next` delta. This table
 * records, per companion, the signature of the definition it was last rebuilt
 * from. A matching signature means "built from this definition and maintained
 * ever since", so the companion is trusted; anything else rebuilds it. Codegen
 * builds a ctx-db per dispatch, so a per-instance memo alone would rescan the
 * table on every request.
 *
 * **Invariant: every write to a source table goes through the ctx-db writer**,
 * whose write paths run the ensure hook before the row write and the companion
 * delta after it. While the rebuild ran once per ctx-db, a write that bypassed
 * the writer was healed by the next dispatch. Now nothing heals it: the
 * companion stays wrong until its definition changes. A path that has to write
 * a source table some other way must call {@link clearCompanionSignatures} so
 * the next touch rebuilds.
 *
 * Markers for companions the schema no longer declares are pruned on every cold
 * start: while an index is undeclared nothing maintains its companion, so
 * re-declaring it with the identical definition must rebuild rather than trust
 * the old marker. A rollback to a build that predates this table cannot prune,
 * which is what the `rebuildCompanions` admin op is for.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-companion-state" mirrors its parent "ctx-db.ts" (the established public module name). */

import { sql as dsql } from "drizzle-orm";

import { compareStrings, encodeAggregateKey } from "./aggregate-tally";
// Type-only import for the structural surface threaded in — a value import
// would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { sqliteInList } from "./drizzle";
import type { AggregateIndexDefinitionLike, RankIndexDefinitionLike } from "./schema-types";

/** Reserved table holding one rebuild marker per aggregate or rank companion. */
const COMPANION_STATE_TABLE = "__lunora_companion_state";

/**
 * Version 1 of the aggregate rebuild's output: one `(__key__, __value__,
 * __count__)` row per canonical `by`-key, folded by `foldAggregateTally` over
 * the LIVE rows matching the static `where`. Bump it when that output changes,
 * so every shard rebuilds each aggregate companion once on its next touch.
 */
const AGGREGATE_FORMAT_VERSION = 1;

/**
 * Version 1 of the rank rebuild's output: one `(__id__, __partition__,
 * __sort_k<i>__…)` row per LIVE source row matching the static `where`. Bump it
 * when that output changes.
 */
const RANK_FORMAT_VERSION = 1;

/** A static `where`, in a key order that does not depend on how it was declared. */
const whereSignature = (where: Record<string, unknown> | undefined): string => (where ? encodeAggregateKey(Object.keys(where), where) : "");

/**
 * Everything an aggregate rebuild's output depends on. A changed `by` /
 * `field` / `op` / `where`, or a toggled `.softDelete()`, differs here and
 * rebuilds instead of answering out of a stale grouping.
 */
const aggregateSignature = (index: AggregateIndexDefinitionLike, softField: string | undefined): string =>
    JSON.stringify([
        AGGREGATE_FORMAT_VERSION,
        (index.by ?? []).toSorted(compareStrings),
        index.field ?? "",
        index.op,
        whereSignature(index.where),
        softField ?? "",
    ]);

/**
 * Everything a rank rebuild's output depends on: the partition key (sorted,
 * like `encodePartitionKey`), the sort fields in column order, the static
 * `where`, and the soft-delete field. A sort DIRECTION is not here — it shapes
 * the btree index, not the stored rows.
 */
const rankSignature = (index: RankIndexDefinitionLike, softField: string | undefined): string =>
    JSON.stringify([
        RANK_FORMAT_VERSION,
        (index.partitionBy ?? []).toSorted(compareStrings),
        index.sortBy.map((key) => key.field),
        whereSignature(index.where),
        softField ?? "",
    ]);

const createStateTable = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(COMPANION_STATE_TABLE)} (${dsql.identifier("companion")} TEXT PRIMARY KEY, ${dsql.identifier("signature")} TEXT NOT NULL)`,
    );
};

/**
 * Create the marker table and drop every marker whose companion is not in
 * `declared` — the companion table names `runShardMigrations` collected while
 * migrating the schema. Called on every cold start.
 */
const migrateCompanionState = (sql: SqlExec, declared: ReadonlyArray<string>): void => {
    createStateTable(sql);

    // One statement either way; an empty `NOT IN ()` is a SQLite extension, so the empty schema says what it means.
    runDrizzle(
        sql,
        declared.length === 0
            ? dsql`DELETE FROM ${dsql.identifier(COMPANION_STATE_TABLE)}`
            : dsql`DELETE FROM ${dsql.identifier(COMPANION_STATE_TABLE)} WHERE ${sqliteInList(dsql.raw(`"companion"`), declared, true)}`,
    );
};

/** The signature `companion` was last rebuilt from, or `undefined` when it has no marker. */
const readCompanionSignature = (sql: SqlExec, companion: string): string | undefined =>
    runDrizzle<{ signature: string }>(
        sql,
        dsql`SELECT ${dsql.identifier("signature")} FROM ${dsql.identifier(COMPANION_STATE_TABLE)} WHERE ${dsql.identifier("companion")} = ${companion}`,
    ).toArray()[0]?.signature;

/** Record that `companion` was just rebuilt from `signature`. Written last, so a rebuild cut short is redone. */
const writeCompanionSignature = (sql: SqlExec, companion: string, signature: string): void => {
    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(COMPANION_STATE_TABLE)} (${dsql.identifier("companion")}, ${dsql.identifier("signature")}) VALUES (${companion}, ${signature}) ON CONFLICT (${dsql.identifier("companion")}) DO UPDATE SET ${dsql.identifier("signature")} = excluded.${dsql.identifier("signature")}`,
    );
};

/**
 * Drop every marker, so each companion rebuilds on its next touch. Creates the
 * table first: the `rebuildCompanions` admin op may reach a shard whose base
 * class never migrated a schema.
 */
const clearCompanionSignatures = (sql: SqlExec): void => {
    createStateTable(sql);
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(COMPANION_STATE_TABLE)}`);
};

export { aggregateSignature, clearCompanionSignatures, migrateCompanionState, rankSignature, readCompanionSignature, writeCompanionSignature };
