/**
 * `.memory()` tables — the shard's ephemeral tier.
 *
 * A memory table is an ordinary table in every way a query cares about: it is
 * created by `runShardMigrations` with the same `(id, _creationTime, __doc__)`
 * layout, carries the same indexes, and answers `where` / `orderBy` /
 * pagination / relations / live queries through the same compiler. The only
 * difference is its LIFETIME. Its rows are wiped whenever the Durable Object is
 * reconstructed, which puts it on the same footing as the DO's JS heap — and
 * the heap is the mental model to hold, because that is the state a memory
 * table stands in for.
 *
 * **Why a real table rather than a heap `Map`.** The obvious implementation —
 * keep rows in memory — would mean re-implementing indexes, the `where`
 * compiler, pagination, relation loading, and the reactive read footprint
 * against a second storage model, and every one of those would drift from the
 * SQL path over time. This package already learned the cost of parallel
 * mental models the hard way twice, when a hibernation eviction silently
 * cleared a `WeakMap` that the durable path had no idea existed (see
 * `ctx-db-global-shape-snapshot.ts` and `ctx-db-shape-poke-cursor.ts`). Wiping a
 * real table gets the ephemeral semantics with ONE storage model and zero new
 * query code.
 *
 * **What this does and does not buy.** It buys the lifetime, and it keeps
 * memory-table writes out of the CDC changelog — which matters, because
 * `trimCdcChanges` is never invoked from `ShardDO` and a heartbeat-rate presence
 * table would otherwise grow the op-log without bound for the life of the shard.
 * It does NOT avoid the write: on Cloudflare, workerd exposes one SQL handle and
 * no memory-backed database, so the row still goes to disk. `.memory()` means
 * "state I am happy to lose", never "state that is free to write".
 *
 * **The ordering that makes it safe.** {@link clearMemoryTables} runs from the
 * generated shard's `ensureShardInit`, which the DO base awaits at every
 * dispatch chokepoint before user code runs — so a handler cannot observe a
 * memory table between the eviction that emptied it and the `onShardInit` hooks
 * that refill it. That window is the entire hazard this feature carries, and
 * closing it in the base class rather than at each call site is deliberate: a
 * missed call site would not fail loudly, it would serve a silently empty table.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-memory" mirrors its parent "ctx-db.ts" (the established public module name). */

import { sql as dsql } from "drizzle-orm";

import type { SchemaLike, SqlExec, TableDefinitionLike } from "./ctx-db";
import { runDrizzle } from "./do-exec";

/**
 * Is `definition` a `.memory()` table? Central so the write path, the migration
 * pass, and the export/backup paths all ask the same question.
 * @returns `true` when the table was declared `.memory()`.
 */
const isMemoryTable = (definition: TableDefinitionLike | undefined): boolean => definition?.memoryMode === true;

/**
 * Every `.memory()` table in `schema`, in declaration order. `.global()` tables
 * are skipped for the same reason the migration pass skips them — they live in
 * D1, not here — though `defineSchema` already rejects that combination.
 * @returns the memory-table names this shard owns.
 */
const memoryTableNames = (schema: SchemaLike): string[] =>
    Object.entries(schema.tables)
        .filter(([, definition]) => isMemoryTable(definition) && definition.shardMode?.kind !== "global")
        .map(([name]) => name);

/**
 * Empty every `.memory()` table. Called once per Durable Object instance, before
 * any handler runs.
 *
 * `DELETE FROM` rather than `DROP`/`CREATE`: the table's indexes and companion
 * tables are created by the migration pass and dropping the table would take
 * them with it. Deleting the rows leaves the schema intact and is what a fresh
 * heap looks like.
 *
 * Only plain `.index()` declarations survive this, and that is enforced
 * upstream: a search / geo / aggregate / rank / vector companion is a SEPARATE
 * table (or, for vectors, an external index) that `DELETE FROM base` does not
 * touch, so it would go on describing rows that no longer exist. `defineSchema`
 * rejects those combinations outright rather than leaving this function to
 * chase every companion kind the engine grows.
 * @returns the number of tables cleared.
 */
const clearMemoryTables = (sql: SqlExec, schema: SchemaLike): number => {
    const names = memoryTableNames(schema);

    for (const name of names) {
        runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(name)}`);
    }

    return names.length;
};

export { clearMemoryTables, isMemoryTable, memoryTableNames };
