/**
 * Schema migrations for the DO store, extracted from `ctx-db.ts`.
 *
 * `runShardMigrations` brings the Durable Object's SQLite database into the
 * shape declared by `schema`: it creates the per-table `(id, _creationTime,
 * __doc__)` row table and then layers on the secondary/`.unique()` expression
 * indexes, the FTS5 search shadow tables, the aggregate-counter companions, and
 * the rank companion tables + their sorted btree index — finally provisioning
 * the CDC log/epoch (when enabled) and the always-present idempotency table.
 *
 * Every statement is `IF NOT EXISTS`, so the whole pass is idempotent and safe
 * to call on every cold start. Global (`.global()`) tables live in D1, not the
 * DO, so they're skipped here. `ctx-db.ts` re-exports `runShardMigrations` so
 * existing import sites (shard-do, the index barrel, tests) are unchanged.
 */

import { LunoraError } from "@lunora/errors";
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { ftsTableName } from "@lunora/search-core";
import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

import { aggregateTableName } from "./aggregate-tally";
// Type-only imports for the structural surfaces threaded in — value imports
// would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SchemaLike, SqlExec, TableDefinitionLike } from "./ctx-db";
import { backfillSearchIndexesForTable } from "./ctx-db-backfill";
import { migrateCdcLog, migrateCdcMeta } from "./ctx-db-cdc";
import { migrateClientWatermark } from "./ctx-db-client-watermark";
import { migrateCommitSeq } from "./ctx-db-commit-seq";
import { migrateCompanionState } from "./ctx-db-companion-state";
import { migrateGlobalShapeSnapshot } from "./ctx-db-global-shape-snapshot";
import { migrateIdempotency } from "./ctx-db-idempotency";
import { migrateRelayShapes } from "./ctx-db-relay-shapes";
import { migrateScheduleOutbox } from "./ctx-db-schedule-outbox";
import { migrateSearchState } from "./ctx-db-search-state";
import { migrateShapePokeCursor } from "./ctx-db-shape-poke-cursor";
import { runAll, runDrizzle } from "./do-exec";
import { AGG_COUNT, AGG_KEY, AGG_VALUE, createIndexSql, DOC_COLUMN, geoTableName, isFtsAvailable, jsonPathSql, tableColumns } from "./do-sql";
import { renderSql } from "./drizzle";
import { migrateDurableStreams } from "./durable-stream";
import { ftsCompanionDdl } from "./fts-companion";
import { rankTableName, sortColumnName } from "./rank";
import { migrateReactorState } from "./reactor-state";
import { recordSchemaVersion } from "./schema-history";
import { ttlIndexColumns } from "./ttl-sweep";

/**
 * Every filtered read this store emits ends `ORDER BY _creationTime ASC, id ASC`
 * (the default total order; see `compileOrderByText`). An index on the filter
 * expressions ALONE cannot satisfy that ordering, so SQLite answers
 * `WHERE f = ? ORDER BY _creationTime, id LIMIT n` by reading every matching row
 * into a temp B-tree, sorting it, and returning n:
 *
 * `SEARCH messages USING INDEX messages_by_channel (<expr>=?)` followed by
 * `USE TEMP B-TREE FOR ORDER BY` — sorting every match to return two rows.
 *
 * That makes the most common read in the framework — `.withIndex(f).first()`, a
 * paginated feed — cost O(matching rows) instead of O(limit), and get worse as
 * the table grows rather than staying flat. Measured on `node:sqlite`, a
 * `LIMIT 2` over one key: 35.8us at 250 rows per key, 407.5us at 2500. With the
 * sort keys in the index it is 3.0us and 3.1us — flat, and the temp B-tree is
 * gone from the plan.
 *
 * DESC reads keep the index too (SQLite walks it backwards); only a MIXED
 * direction would still need a partial sort — which is why the implicit `id`
 * tiebreak follows the last sort key's direction (see `tiebreakDirectionFor`),
 * so a descending read stays an index walk rather than producing that shape.
 *
 * The geo and rank companions (below) already index their sort keys. This brings
 * the user-declared index in line with them.
 */
const INDEX_SORT_KEYS = dsql`_creationTime, id`;

/**
 * Suffix of the default-order index on a table. It is the only framework index on
 * the table itself: the rank, geo, aggregate and search companions (`__rank_`,
 * `__geo_`, `__agg_`, `__fts_`) index their own companion tables, so a lookup by
 * `tbl_name` never sees them. A declared index named `_x` is `<table>__x`, which
 * is why the exclusion is this exact name and not the whole `<table>__` prefix.
 */
const BY_CREATION_INDEX_SUFFIX = "__by_creation";

/** Suffix of the framework index behind a `.ttl()` table's expiry sweep. */
const TTL_INDEX_SUFFIX = "__ttl";

/** How a sort-keyed index's `CREATE INDEX` statement ends, rendered from {@link INDEX_SORT_KEYS}. */
const INDEX_SORT_KEYS_TAIL = `, ${renderSql("sqlite", INDEX_SORT_KEYS).sql})`;

/**
 * Reserved table recording the secondary and `.unique()` indexes this module created, by name. It is what decides which
 * index {@link dropUndeclaredIndexes} may drop: an index someone made by hand is not in it, however closely its name and
 * SQL resemble ours. `name` compares case-insensitively because SQLite does for an index name.
 */
const INDEX_LEDGER_TABLE = "__lunora_framework_indexes";

/** An identifier as SQLite compares it: ASCII letters folded, everything else untouched. Not `toLowerCase()`, which also equates `ä` and `Ä`. */
const foldIdentifier = (name: string): string => name.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

/** One index row from `sqlite_master`, folded for case-insensitive lookup. */
interface IndexCatalogEntry {
    name: string;
    sql: null | string;
    tableFolded: string;
}

/**
 * Pass-local snapshot of `sqlite_master`'s indexes, keyed by folded index name.
 * Read once per {@link runShardMigrations} pass so shape checks, uniqueness
 * guards, and ledger adoption do not re-scan `sqlite_master` per index. Changed
 * only by the helpers that run the DDL, in the same step, so it cannot go stale.
 */
type IndexCatalog = Map<string, IndexCatalogEntry>;

/** Single-scan summary of `sqlite_master` for one {@link runShardMigrations} pass. */
interface MigrationCatalog {
    existingFtsTable: string | undefined;
    indexes: IndexCatalog;
    ledgerExists: boolean;
}

/** One framework-created index as the ledger records it. */
interface LedgerEntry {
    name: string;
    tableFolded: string;
}

/**
 * Pass-local snapshot of {@link INDEX_LEDGER_TABLE}, keyed by folded index name.
 * The ledger's name column is `COLLATE NOCASE`, so a folded name identifies one
 * row. Read once per {@link runShardMigrations} pass.
 */
type IndexLedger = Map<string, LedgerEntry>;

/**
 * The index state one {@link runShardMigrations} pass reads and changes. Index
 * DDL and ledger writes go through helpers that take the pass and update both
 * snapshots in the same step, so they cannot drift from `sqlite_master` or the
 * ledger table.
 */
interface IndexPass {
    catalog: IndexCatalog;
    ledger: IndexLedger;
    sql: SqlExec;
}

const CREATE_VIRTUAL_TABLE_RE = /^CREATE\s+VIRTUAL\s+TABLE\b/iu;
const USING_FTS5_RE = /\bUSING\s+fts5\b/iu;

const isFtsVirtualTableSql = (statement: null | string): boolean =>
    statement !== null && CREATE_VIRTUAL_TABLE_RE.test(statement) && USING_FTS5_RE.test(statement);

/** Read `sqlite_master` once for the entire migration pass. */
const loadMigrationCatalog = (sql: SqlExec): MigrationCatalog => {
    const indexes: IndexCatalog = new Map();
    const ledgerFolded = foldIdentifier(INDEX_LEDGER_TABLE);
    let ledgerExists = false;
    let existingFtsTable: string | undefined;

    for (const row of runDrizzle<{ name: string; sql: null | string; tbl_name: string; type: string }>(
        sql,
        dsql`SELECT type, name, tbl_name, sql FROM sqlite_master`,
    )) {
        if (row.type === "index") {
            indexes.set(foldIdentifier(row.name), { name: row.name, sql: row.sql, tableFolded: foldIdentifier(row.tbl_name) });
        } else if (row.type === "table") {
            if (foldIdentifier(row.name) === ledgerFolded) {
                ledgerExists = true;
            }

            if (existingFtsTable === undefined && isFtsVirtualTableSql(row.sql)) {
                existingFtsTable = row.name;
            }
        }
    }

    return { existingFtsTable, indexes, ledgerExists };
};

/**
 * Execute `CREATE [UNIQUE] INDEX IF NOT EXISTS` and record newly created
 * indexes in the pass catalog. When SQLite already holds an index under `indexName`,
 * `IF NOT EXISTS` is a no-op and the existing catalog entry stays untouched.
 */
const createIndexTracked = (pass: IndexPass, indexName: string, tableName: string, expressions: SQL, unique: boolean): void => {
    const statement = createIndexSql(indexName, tableName, expressions, unique);

    runDrizzle(pass.sql, statement);

    const folded = foldIdentifier(indexName);

    if (!pass.catalog.has(folded)) {
        pass.catalog.set(folded, {
            name: indexName,
            sql: renderSql("sqlite", statement).sql,
            tableFolded: foldIdentifier(tableName),
        });
    }
};

/** Drop an index the pass holds and forget it in the catalog. A ledger row, if any, is the caller's to remove. */
const dropIndex = (pass: IndexPass, indexName: string): void => {
    runDrizzle(pass.sql, dsql`DROP INDEX IF EXISTS ${dsql.identifier(indexName)}`);
    pass.catalog.delete(foldIdentifier(indexName));
};

/**
 * Raised when a UNIQUE index cannot be built because existing rows already violate
 * it. A distinct type so a caller that opted into deferral
 * (`deferBlockedUniqueIndexes`) can tell this recoverable state from a real
 * migration failure, which must keep propagating.
 */
class BlockedUniqueIndexError extends LunoraError {}

/**
 * Refuse to build a UNIQUE index over rows that already violate it.
 *
 * `CREATE UNIQUE INDEX` raises a bare `UNIQUE constraint failed: index '<name>'`
 * on duplicates, and it raises it from inside the cold-start migration. Probing
 * first turns that into a diagnostic that names the table and the remedy.
 *
 * Throwing from the migration would also wedge the shard: the de-dup
 * `defineMigration` that clears the duplicates runs through the admin path, which
 * migrates first. So a host that serves admin traffic passes
 * `deferBlockedUniqueIndexes` to {@link runShardMigrations}: the rest of the pass
 * completes, the blocked index is reported instead of thrown, and the host
 * refuses user dispatch (not admin) until a later pass builds it.
 *
 * Restricted to rows where EVERY indexed column is non-NULL, because the two
 * sides disagree about NULL: `GROUP BY` treats NULLs as equal, a SQLite UNIQUE
 * index treats them as distinct. `json_extract` yields NULL for an unset
 * optional field, so without the filter two rows that simply never set an
 * optional `.unique()` column read as a duplicate and a `CREATE UNIQUE INDEX`
 * that would have SUCCEEDED is refused.
 */
const assertNoDuplicatesUnder = (
    sql: SqlExec,
    indexName: string,
    tableName: string,
    expressions: SQL,
    references: ReadonlyArray<SQL>,
    situation: string,
): void => {
    const nonNull = dsql.join(
        references.map((reference) => dsql`${reference} IS NOT NULL`),
        dsql` AND `,
    );
    const duplicates = runDrizzle(sql, dsql`SELECT 1 FROM ${dsql.identifier(tableName)} WHERE ${nonNull} GROUP BY ${expressions} HAVING COUNT(*) > 1 LIMIT 1`);

    if (duplicates.toArray().length > 0) {
        throw new BlockedUniqueIndexError(
            "UNIQUE_INDEX_DUPLICATES",
            `unique index "${indexName}" on "${tableName}" ${situation}: existing rows are duplicates under it. De-duplicate the table with a data migration first; the previous index is left in place.`,
        );
    }
};

/**
 * Drop `indexName` when the index SQLite already holds was built from a
 * different column list than the one we are about to create.
 *
 * `CREATE INDEX IF NOT EXISTS` is a no-op against an index that exists with a
 * DIFFERENT definition — it does not replace it, and it does not complain. So a
 * shard migrated before {@link INDEX_SORT_KEYS} existed would keep its
 * filter-only index forever and never see the improvement, with nothing in any
 * log to say so.
 *
 * The comparison is on the column list SQLite echoes back in `sqlite_master.sql`
 * (it stores the statement verbatim, minus `IF NOT EXISTS`), against the column
 * list we would emit. Comparing the parenthesised tail rather than the whole
 * statement keeps this insensitive to how the surrounding DDL is spelled.
 *
 * ## Cost
 *
 * The rebuild runs synchronously inside the migration, on whichever request
 * happens to open the shard — the same hazard the `__cdc_log` seq index carries,
 * and the reason that one is wrapped in its own try/catch. It is bounded: one
 * rebuild per changed index per shard, once, and a shard's index set is fixed by
 * its schema. A failure here leaves the OLD index in place (the DROP and CREATE
 * are separate statements and the throw propagates), which is the safe
 * direction — a slower index is a working one.
 */
const dropIndexIfShapeChanged = (
    pass: IndexPass,
    indexName: string,
    tableName: string,
    expressions: SQL,
    unique: boolean,
    references: ReadonlyArray<SQL>,
): void => {
    const entry = pass.catalog.get(foldIdentifier(indexName));
    const current = entry?.tableFolded === foldIdentifier(tableName) ? entry.sql : undefined;

    // No row, or an implicit index SQLite created for a constraint (`sql` is
    // NULL there) — nothing of ours to replace.
    if (current === undefined || current === null) {
        return;
    }

    const columnsOf = (statement: string): string | undefined => {
        const open = statement.indexOf("(");

        return open === -1 ? undefined : statement.slice(open, statement.lastIndexOf(")") + 1);
    };

    const wanted = columnsOf(renderSql("sqlite", createIndexSql(indexName, tableName, expressions, unique)).sql);
    const held = columnsOf(current);

    if (wanted === undefined || held === undefined || wanted === held) {
        return;
    }

    // A UNIQUE index is dropped only once the new shape is known to be
    // creatable. Dropping first and letting the follow-up `CREATE UNIQUE INDEX`
    // fail on rows that are duplicates under the NEW column list leaves the
    // table with no constraint at all — and the failed migration re-runs and
    // re-fails on every wake, so the gap never closes on its own. Refusing keeps
    // the old constraint in force and names what has to be de-duplicated.
    //
    // The column comparison and this guard match the sql-store twin
    // (`packages/sql-store/src/ctx-db-migrations.ts`) on purpose: a guard on one
    // destructive DDL path but not the other is worse than the duplication. Only
    // where `current` comes from differs: here the pass catalog, there a
    // `sqlite_master` query per index.
    if (unique) {
        assertNoDuplicatesUnder(pass.sql, indexName, tableName, expressions, references, "cannot be re-created with its new column list");
    }

    dropIndex(pass, indexName);
};

/**
 * Whether SQLite already holds an index under this name on this table.
 *
 * The duplicate probe below is a `GROUP BY` over the whole table, so it only
 * runs when the `CREATE ... IF NOT EXISTS` that follows would really build
 * something — an index already in place has been enforcing the constraint all
 * along, and re-scanning for it on every cold start would be pure cost.
 */
const indexIsHeld = (catalog: IndexCatalog, indexName: string, tableName: string): boolean =>
    catalog.get(foldIdentifier(indexName))?.tableFolded === foldIdentifier(tableName);

/**
 * Create one index, probing for duplicates first when it is UNIQUE and not yet
 * provisioned — see {@link assertNoDuplicatesUnder}. Both producers of a UNIQUE
 * index (a declared `unique: true` index, a `.unique()` column) go through here,
 * so neither can reach `CREATE UNIQUE INDEX` unguarded.
 */
const createIndexGuarded = (pass: IndexPass, indexName: string, tableName: string, expressions: SQL, unique: boolean, references: ReadonlyArray<SQL>): void => {
    if (unique && !indexIsHeld(pass.catalog, indexName, tableName)) {
        assertNoDuplicatesUnder(pass.sql, indexName, tableName, expressions, references, "cannot be created");
    }

    createIndexTracked(pass, indexName, tableName, expressions, unique);
};

/**
 * Run one index build; when `blocked` is supplied, a {@link BlockedUniqueIndexError}
 * is recorded there instead of propagating, so the remaining indexes and tables
 * still migrate. Any other failure still throws.
 */
const deferIfBlocked = (blocked: string[] | undefined, build: () => void): void => {
    try {
        build();
    } catch (error) {
        if (blocked === undefined || !(error instanceof BlockedUniqueIndexError)) {
            throw error;
        }

        blocked.push(error.message);
    }
};

/**
 * Whether an index that predates the ledger looks like one this module created: named `<table>_<something>` (bar the
 * default-order {@link BY_CREATION_INDEX_SUFFIX} index) and built over the document column's JSON path or ending in the
 * {@link INDEX_SORT_KEYS} suffix. Only used once, to adopt the indexes of a database that has no ledger yet.
 */
const looksFrameworkCreated = (tableName: string, name: string, statement: null | string): boolean =>
    foldIdentifier(name).startsWith(`${foldIdentifier(tableName)}_`) &&
    foldIdentifier(name) !== foldIdentifier(`${tableName}${BY_CREATION_INDEX_SUFFIX}`) &&
    statement !== null &&
    (statement.includes("json_extract(") || statement.trimEnd().endsWith(INDEX_SORT_KEYS_TAIL));

/** Read {@link INDEX_LEDGER_TABLE} once for the entire migration pass. */
const loadIndexLedger = (sql: SqlExec): IndexLedger => {
    const ledger: IndexLedger = new Map();

    for (const row of runDrizzle<{ name: string; table_name: string }>(sql, dsql`SELECT name, table_name FROM ${dsql.identifier(INDEX_LEDGER_TABLE)}`)) {
        ledger.set(foldIdentifier(row.name), { name: row.name, tableFolded: foldIdentifier(row.table_name) });
    }

    return ledger;
};

/** Note that this module owns the index `indexName` on `tableName`. */
const recordFrameworkIndex = (pass: IndexPass, indexName: string, tableName: string): void => {
    const folded = foldIdentifier(indexName);

    if (pass.ledger.has(folded)) {
        return;
    }

    runDrizzle(pass.sql, dsql`INSERT OR IGNORE INTO ${dsql.identifier(INDEX_LEDGER_TABLE)} (name, table_name) VALUES (${indexName}, ${tableName})`);
    pass.ledger.set(folded, { name: indexName, tableFolded: foldIdentifier(tableName) });
};

/** Whether this module recorded `indexName` as its own, as opposed to an index someone created by hand. */
const isFrameworkIndex = (ledger: IndexLedger, indexName: string): boolean => ledger.has(foldIdentifier(indexName));

/**
 * Create the ledger of framework-created indexes. A database that has none yet predates it, so the first run adopts every
 * index the old name-and-SQL-shape rule would have called ours: a stale one is then still dropped exactly once, and from
 * then on only the ledger decides.
 *
 * The adoption follows the CREATE in the same synchronous turn, which a Durable Object commits as one write.
 */
const ensureIndexLedger = (sql: SqlExec, migrationCatalog: MigrationCatalog, tableNames: ReadonlyArray<string>): IndexLedger => {
    runDrizzle(sql, dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(INDEX_LEDGER_TABLE)} (name TEXT PRIMARY KEY COLLATE NOCASE, table_name TEXT NOT NULL)`);

    if (migrationCatalog.ledgerExists) {
        return loadIndexLedger(sql);
    }

    const pass: IndexPass = { catalog: migrationCatalog.indexes, ledger: new Map(), sql };
    const tableNamesByFolded = new Map(tableNames.map((tableName) => [foldIdentifier(tableName), tableName]));

    for (const entry of migrationCatalog.indexes.values()) {
        if (entry.sql === null) {
            continue;
        }

        const tableName = tableNamesByFolded.get(entry.tableFolded);

        if (tableName !== undefined && looksFrameworkCreated(tableName, entry.name, entry.sql)) {
            recordFrameworkIndex(pass, entry.name, tableName);
        }
    }

    return pass.ledger;
};

/**
 * Drop the indexes this module created for a table that its schema no longer declares.
 *
 * `CREATE INDEX IF NOT EXISTS` only ever adds, so a `.unique()` taken off a column
 * kept rejecting duplicates (as `ConflictError`) forever, and an index removed from
 * a table's declarations kept taxing every write.
 *
 * Only indexes in the {@link INDEX_LEDGER_TABLE} are candidates, so an index added
 * by hand is left alone whatever it looks like — and so is one on a system field
 * (`_creationTime`), which no shape test could have told from a hand-made one.
 */
const dropUndeclaredIndexes = (pass: IndexPass, tableName: string, declared: ReadonlySet<string>): void => {
    const tableFolded = foldIdentifier(tableName);

    // SQLite folds ASCII case in an identifier, so `By_Slug` IS `by_slug`: an index renamed that way
    // is the declared one, and dropping it would leave the table with nothing.
    const declaredFolded = new Set([...declared].map((name) => foldIdentifier(name)));

    for (const [folded, entry] of pass.ledger) {
        if (entry.tableFolded !== tableFolded || declaredFolded.has(folded)) {
            continue;
        }

        dropIndex(pass, entry.name);
        runDrizzle(pass.sql, dsql`DELETE FROM ${dsql.identifier(INDEX_LEDGER_TABLE)} WHERE ${dsql.identifier(INDEX_LEDGER_TABLE)}."name" = ${entry.name}`);
        pass.ledger.delete(folded);
    }
};

/**
 * Create the expression index behind a `.ttl()` table's sweep (see
 * `ttlIndexColumns`). Without it the sweep's `field < cutoff` reads the whole
 * table on every wake, since with nothing expired its LIMIT never stops the scan.
 *
 * Isolated like the `__cdc_log` indexes: the first build decodes every row's
 * JSON on the request that opens the shard, and a failure leaves the sweep on
 * its scan rather than failing the migration. The next cold start retries.
 */
const migrateTtlIndex = (pass: IndexPass, tableName: string, definition: TableDefinitionLike, declared: Set<string>): void => {
    const indexName = `${tableName}${TTL_INDEX_SUFFIX}`;

    // A declared index already holds the name; never replace a user's index. SQLite folds
    // ASCII case in identifiers, so a case variant of the name is the same index.
    const declaredFolded = new Set([...declared].map((name) => foldIdentifier(name)));

    if (definition.ttlPolicy === undefined || declaredFolded.has(foldIdentifier(indexName))) {
        return;
    }

    // An index under this name that the ledger does not hold was made by hand; replacing it would drop it, and a
    // unique one would stop enforcing its constraint.
    if (indexIsHeld(pass.catalog, indexName, tableName) && !isFrameworkIndex(pass.ledger, indexName)) {
        return;
    }

    const expressions = ttlIndexColumns(definition.ttlPolicy.field, definition.softDeleteMode?.field);

    declared.add(indexName);

    try {
        dropIndexIfShapeChanged(pass, indexName, tableName, expressions, false, []);
        createIndexTracked(pass, indexName, tableName, expressions, false);
        recordFrameworkIndex(pass, indexName, tableName);
    } catch {
        /* degraded sweep path; the next cold start retries */
    }
};

/**
 * Create the secondary + `.unique()` expression indexes declared on a table.
 *
 * A UNIQUE index does NOT get the sort keys appended: they would become part of
 * what is unique, and `(email, _creationTime, id)` is unique for every row, so
 * the constraint would silently stop rejecting duplicates. That is data
 * corruption rather than a slow query, so the two cases are split deliberately.
 */
const migrateSecondaryIndexes = (pass: IndexPass, tableName: string, definition: TableDefinitionLike, blocked: string[] | undefined): void => {
    const declared = new Set<string>();

    for (const index of definition.indexes) {
        const indexName = `${tableName}_${index.name}`;

        const unique = index.unique ?? false;
        const references = index.fields.map((field) => jsonPathSql(field));
        const fields = dsql.join(references, dsql`, `);
        const expressions = unique ? fields : dsql`${fields}, ${INDEX_SORT_KEYS}`;

        declared.add(indexName);
        deferIfBlocked(blocked, () => {
            dropIndexIfShapeChanged(pass, indexName, tableName, expressions, unique, references);
            createIndexGuarded(pass, indexName, tableName, expressions, unique, references);
            recordFrameworkIndex(pass, indexName, tableName);
        });
    }

    // `.unique()` columns synthesize a UNIQUE expression index so SQLite
    // enforces the constraint; the write layer maps breaches to ConflictError.
    for (const [field, column] of tableColumns(definition)) {
        if (!column.unique) {
            continue;
        }

        const reference = jsonPathSql(field);
        const indexName = `${tableName}_unique_${field}`;

        declared.add(indexName);
        deferIfBlocked(blocked, () => {
            // The name only differs from a held one by the field's case, whose path is another expression.
            dropIndexIfShapeChanged(pass, indexName, tableName, reference, true, [reference]);
            createIndexGuarded(pass, indexName, tableName, reference, true, [reference]);
            recordFrameworkIndex(pass, indexName, tableName);
        });
    }

    migrateTtlIndex(pass, tableName, definition, declared);
    dropUndeclaredIndexes(pass, tableName, declared);
};

/**
 * Create the FTS5 shadow tables for a table's `.searchIndex()` declarations,
 * only on engines that ship FTS5 (Cloudflare DOs do; the `node:sqlite` test
 * runner doesn't, where `.search()` transparently falls back to a scan).
 * `__text__` holds the indexed field; `__id__` (UNINDEXED) joins back to the row,
 * and the `__ids` map beside it finds a document's row without a scan. Rows a
 * previous build wrote are rewritten into that layout a bounded page per cold
 * start (see `fts-companion.ts`).
 *
 * A freshly created shadow is then backfilled from the rows already in the
 * table, so declaring a search index on a table that already holds data makes
 * that data searchable — without it the index would only ever see rows written
 * after* the deploy. `staged: true` opts out for large tables; a host populates
 * those out-of-band with `backfillSearchIndexes`.
 */
const migrateSearchIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike, existingFtsTable: string | undefined): void => {
    if (!definition.searchIndexes || definition.searchIndexes.length === 0 || !isFtsAvailable(sql, existingFtsTable)) {
        return;
    }

    for (const index of definition.searchIndexes) {
        runAll(sql, ftsCompanionDdl(ftsTableName(tableName, index.name)));
    }

    backfillSearchIndexesForTable(sql, tableName, definition);
};

/**
 * Create the geohash companion tables backing `.geoIndex()` declarations. One
 * row per source row keyed by `__id__`, carrying the geohash prefix plus the raw
 * `__lat__`/`__lng__` so `withGeoIndex(...)` can range-scan by geohash and then
 * Haversine-refine without re-decoding the source doc. A btree on
 * `(__geohash__, __id__)` answers the prefix range scan.
 */
const migrateGeoIndexes = (pass: IndexPass, tableName: string, definition: TableDefinitionLike): void => {
    if (!definition.geoIndexes) {
        return;
    }

    for (const index of definition.geoIndexes) {
        const geoTable = geoTableName(tableName, index.name);

        runDrizzle(
            pass.sql,
            dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(geoTable)} (${dsql.identifier("__id__")} TEXT PRIMARY KEY, ${dsql.identifier("__geohash__")} TEXT NOT NULL, ${dsql.identifier("__lat__")} REAL NOT NULL, ${dsql.identifier("__lng__")} REAL NOT NULL)`,
        );

        const btreeName = `${tableName}__geo_${index.name}__btree`;

        createIndexTracked(pass, btreeName, geoTable, dsql`${dsql.identifier("__geohash__")} ASC, ${dsql.identifier("__id__")} ASC`, false);
    }
};

/**
 * Create the counter tables backing `aggregateIndex` declarations. One row per
 * distinct `by`-tuple; `__key__` is a canonical-JSON encoding so lookups stay
 * stable. Not populated here — the first touch rebuilds a companion whose
 * durable marker (`ctx-db-companion-state`) does not match its definition, and
 * the write path steps every counter from then on.
 */
const migrateAggregateIndexes = (sql: SqlExec, tableName: string, definition: TableDefinitionLike): void => {
    if (!definition.aggregateIndexes) {
        return;
    }

    for (const index of definition.aggregateIndexes) {
        const aggTable = aggregateTableName(tableName, index.name);

        // `__value__` is nullable now (an empty min/max group stores NULL); the
        // pre-reducer-aware shape declared it `NOT NULL` and carried only a row
        // count. `CREATE TABLE IF NOT EXISTS` won't reshape a table that already
        // exists, so the defensive `ADD COLUMN` below upgrades a companion
        // persisted by an older alpha build.
        runDrizzle(
            sql,
            dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(aggTable)} (${AGG_KEY} TEXT PRIMARY KEY, ${AGG_VALUE} REAL, ${AGG_COUNT} INTEGER NOT NULL DEFAULT 0)`,
        );

        // Alpha-era companion-rebuild caveat: a DO persisted before `__count__`
        // existed gets the column added here (defaulted 0). Such a DO also predates
        // the durable marker, so the first read/write that touches the index
        // rebuilds it and overwrites the seeded 0s with real per-op values — no
        // stale count survives. We pragma-check rather than blindly ALTER so a
        // fresh table (created above with the column) doesn't raise "duplicate column".
        const columns = runDrizzle<{ name: string }>(sql, dsql`PRAGMA table_info(${dsql.identifier(aggTable)})`).toArray();

        if (!columns.some((column) => column.name === "__count__")) {
            runDrizzle(sql, dsql`ALTER TABLE ${dsql.identifier(aggTable)} ADD COLUMN ${AGG_COUNT} INTEGER NOT NULL DEFAULT 0`);
        }
    }
};

/**
 * Drop a rank companion whose `__sort_k<i>__` columns no longer match the declared
 * `sortBy`. `CREATE TABLE IF NOT EXISTS` never reshapes a table that exists, so a
 * `sortBy` that gained a key would leave the companion without the column its
 * rebuild INSERTs into, and every write to the source table would fail with "no
 * such column". The companion is derived data: its rebuild marker keys on the sort
 * fields, so the changed `sortBy` that got us here also rebuilds it on its next
 * touch. Dropping the table takes its btree index with it.
 */
const dropRankCompanionIfColumnsChanged = (pass: IndexPass, rankTable: string, sortColumns: ReadonlyArray<string>): void => {
    const held = runDrizzle<{ name: string }>(pass.sql, dsql`PRAGMA table_info(${dsql.identifier(rankTable)})`)
        .toArray()
        .map((column) => column.name)
        .filter((name) => name.startsWith("__sort_k"));

    // An absent table reports no columns, so there is nothing to drop.
    if (held.length > 0 && (held.length !== sortColumns.length || held.some((name, i) => name !== sortColumns[i]))) {
        runDrizzle(pass.sql, dsql`DROP TABLE ${dsql.identifier(rankTable)}`);

        const rankTableFolded = foldIdentifier(rankTable);

        for (const [indexFolded, entry] of pass.catalog) {
            if (entry.tableFolded === rankTableFolded) {
                pass.catalog.delete(indexFolded);
            }
        }
    }
};

/**
 * Create the rank companion tables + their sorted btree index for a table's
 * `rankIndex` declarations. One row per source row keyed by `__id__`; the index
 * on `(__partition__, __sort_k0__, …, __id__)` answers `rank()` in O(log n).
 */
const migrateRankIndexes = (pass: IndexPass, tableName: string, definition: TableDefinitionLike): void => {
    if (!definition.rankIndexes) {
        return;
    }

    for (const index of definition.rankIndexes) {
        const rankTable = rankTableName(tableName, index.name);
        const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
        const columnDdls = sortColumns.map((column) => dsql`${dsql.identifier(column)} BLOB`);
        const columnPart = columnDdls.length > 0 ? dsql`, ${dsql.join(columnDdls, dsql`, `)}` : dsql``;

        dropRankCompanionIfColumnsChanged(pass, rankTable, sortColumns);

        runDrizzle(
            pass.sql,
            dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(rankTable)} (${dsql.identifier("__id__")} TEXT PRIMARY KEY, ${dsql.identifier("__partition__")} TEXT NOT NULL${columnPart})`,
        );

        // Sorted btree: (partition, sortBy ASC/DESC..., __id__ ASC)
        const orderedColumns: SQL[] = [dsql`${dsql.identifier("__partition__")} ASC`];

        for (const [i, column] of sortColumns.entries()) {
            const direction = index.sortBy[i]?.direction;

            orderedColumns.push(dsql`${dsql.identifier(column)} ${dsql.raw(direction === "desc" ? "DESC" : "ASC")}`);
        }

        orderedColumns.push(dsql`${dsql.identifier("__id__")} ASC`);

        const btreeName = `${tableName}__rank_${index.name}__btree`;

        const btreeColumns = dsql.join(orderedColumns, dsql`, `);

        // A flipped sort direction changes the btree's column list under the same name.
        dropIndexIfShapeChanged(pass, btreeName, rankTable, btreeColumns, false, []);
        createIndexTracked(pass, btreeName, rankTable, btreeColumns, false);
    }
};

/**
 * Bring the SQLite database into the shape declared by `schema`. Idempotent
 * — every statement uses `IF NOT EXISTS`, so it's safe to call on every
 * cold start.
 *
 * Global tables (`.global()`) live in D1, not in the DO — they're skipped
 * here. The DO sees them via the D1 adapter exposed elsewhere.
 *
 * Returns the diagnostics of UNIQUE indexes that were deferred (always empty
 * unless `deferBlockedUniqueIndexes` is set).
 */
// eslint-disable-next-line import/prefer-default-export -- named export: import sites stay uniform (`import { runShardMigrations }`), per the repo's no-default-mixing convention
export const runShardMigrations = (
    sql: SqlExec,
    schema: SchemaLike,
    options: {
        cdc?: boolean;

        /**
         * Report a UNIQUE index that existing duplicate rows block, rather than
         * throwing: every other table, index and companion still migrates. The
         * blocked index stays absent (or keeps its previous shape) until a later
         * pass finds the table de-duplicated.
         *
         * Opt-in on purpose: the returned list is the host's only signal that a
         * unique index is missing. A host that ignores it (the in-process host, the
         * conformance suite) must leave this off and let the migration throw, or it
         * would serve writes with no uniqueness enforcement and no diagnostic.
         */
        deferBlockedUniqueIndexes?: boolean;
        schemaSnapshot?: { hash: string; json: string };
    } = {},
): ReadonlyArray<string> => {
    const blocked: string[] | undefined = options.deferBlockedUniqueIndexes ? [] : undefined;

    // Record this schema shape in the version ledger before touching any table.
    // Codegen threads the snapshot it already computes for the deploy gate, so
    // the ledger and the gate can never describe different shapes. Absent (a
    // hand-built DO, or a project on an older codegen) simply means no history.
    if (options.schemaSnapshot !== undefined) {
        recordSchemaVersion(sql, options.schemaSnapshot.hash, options.schemaSnapshot.json);
    }

    // Read `sqlite_master` once for the pass so per-index shape checks,
    // uniqueness guards, and ledger adoption do not scan the catalog O(indexes)
    // times on every cold start.
    const migrationCatalog = loadMigrationCatalog(sql);
    const shardTableEntries = Object.entries(schema.tables).filter(([, definition]) => definition.shardMode?.kind !== "global");

    // Before any table: the search backfill records its progress here, and it
    // runs inside the per-table pass below.
    migrateSearchState(sql);

    const ledger = ensureIndexLedger(
        sql,
        migrationCatalog,
        shardTableEntries.map(([tableName]) => tableName),
    );
    const pass: IndexPass = { catalog: migrationCatalog.indexes, ledger, sql };

    const declaredCompanions: string[] = [];

    for (const [tableName, definition] of shardTableEntries) {
        runDrizzle(
            sql,
            dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(tableName)} (
                id TEXT PRIMARY KEY,
                _creationTime REAL NOT NULL,
                ${dsql.identifier(DOC_COLUMN)} TEXT NOT NULL
            )`,
        );

        // The DEFAULT total order, `_creationTime ASC, id ASC`, which every read
        // that names no `.withIndex()` and no `orderBy` sorts by — `paginate()`,
        // `findMany({ limit })`, `.first()`, and every generated REST list
        // endpoint whose caller sends no filter. The row table above declares
        // only `id TEXT PRIMARY KEY`, so nothing indexed that order and SQLite
        // read the WHOLE table into a temp B-tree to return the first page:
        // `SCAN messages | USE TEMP B-TREE FOR ORDER BY`, 1317.9us over 50k rows
        // against 7.3us on an index walk, and O(table) on every page after the
        // first rather than O(page).
        //
        // Both columns are stored (not `json_extract`) so this is an ordinary
        // btree; it is also what makes the descending read an index walk
        // backwards. See `INDEX_SORT_KEYS` for the DECLARED-index twin of the
        // same problem — this covers the reads that declare no index at all.
        //
        // Cold-start cost: an existing shard builds it once, on the first wake
        // after deploy, inside this migration. Measured on `node:sqlite` over a
        // 1,000,000-row table: 369ms, one sort of 1M `(_creationTime, id)` pairs
        // — both stored columns, so no JSON is decoded. Every request that wakes
        // the shard thereafter pays nothing.
        //
        // Left non-incremental deliberately. A resumable build would need a
        // partial index plus a persisted cursor, and would leave the reads this
        // exists for on the O(table) plan for as long as it ran — which on a
        // table big enough to care is the expensive state, not the build.
        createIndexTracked(pass, `${tableName}${BY_CREATION_INDEX_SUFFIX}`, tableName, INDEX_SORT_KEYS, false);

        migrateSecondaryIndexes(pass, tableName, definition, blocked);
        migrateSearchIndexes(sql, tableName, definition, migrationCatalog.existingFtsTable);
        migrateGeoIndexes(pass, tableName, definition);
        migrateAggregateIndexes(sql, tableName, definition);
        migrateRankIndexes(pass, tableName, definition);

        declaredCompanions.push(
            ...(definition.aggregateIndexes ?? []).map((index) => aggregateTableName(tableName, index.name)),
            ...(definition.rankIndexes ?? []).map((index) => rankTableName(tableName, index.name)),
        );
    }

    // After the pass, so it can prune every rebuild marker whose companion the
    // schema no longer declares.
    migrateCompanionState(sql, declaredCompanions);

    if (options.cdc) {
        // The row-history index is only worth its storage when a table actually
        // seeks one row's changelog — i.e. when some table opted into
        // `.dropStalePatches()`.
        migrateCdcLog(sql, { rowHistoryIndex: Object.values(schema.tables).some((table) => table.dropStalePatchesMode === true) });
        // The epoch row lives next to the log so a reconnecting subscriber can
        // prove timeline continuity; created upfront (the row itself is minted
        // lazily by `readCdcEpoch` on first frame).
        migrateCdcMeta(sql);
        // Custom mutators imply CDC, so the per-client watermark table rides the
        // same gate: it holds the monotonic `last_mutation_id` the poke protocol
        // echoes back so the client's outbox can drop confirmed pending writes.
        migrateClientWatermark(sql);
        // An op-log-backed (poke-live) shape diffs against `__cdc_log`, so it
        // cannot exist without CDC either — the durable poke-baseline cursor
        // rides the same gate as the log it indexes into.
        migrateShapePokeCursor(sql);
        // Same gate, same reason, for the RELAYED half of that fan-out: an
        // owner's cohort/proxy registry. It lives in SQLite because an owner in
        // relay mode holds no sockets of its own and is evictable between
        // writes — see `ctx-db-relay-shapes.ts`.
        migrateRelayShapes(sql);
    }

    // Gated on the schema, not on a runtime flag: the `_commitSeq` counter is
    // only allocated from by a `.commitOrdered()` table's write path, so a shard
    // whose schema declares none never creates the table. `Object.values` over
    // the table set is the whole probe — `.commitOrdered()` is a static schema
    // fact, unlike CDC (a host option).
    if (Object.values(schema.tables).some((table) => table.commitOrderedMode === true)) {
        migrateCommitSeq(sql);
    }

    // Always present: a reactor's baseline must survive hibernation, and a
    // `.reactor` can be declared without any schema change — so the table has to
    // exist before the first flush, not when a schema flag says so. Empty (and
    // free) on a shard that declares none.
    migrateReactorState(sql);

    // Always present: the mutation-replay dedup table is independent of CDC and
    // costs nothing until the first id-bearing mutation writes to it.
    migrateIdempotency(sql);

    // Always present, and always NEXT TO the dedup table: the outbox is what makes
    // that table honest. A dedup row says "this mutation succeeded"; without the
    // outbox it can say that about a mutation whose deferred `ctx.scheduler` job
    // never reached the SchedulerDO. A `ctx.scheduler` call needs no schema change
    // to appear, so the table must exist before the first mutation makes one. Empty
    // (and free) on a shard that schedules nothing.
    migrateScheduleOutbox(sql);

    // Always present: the durable per-socket baseline for `.global()`-shape diff
    // pokes. Independent of CDC (global shapes are polled, not poke-live) and
    // empty until the first global shape is seeded, so a non-global DO pays
    // nothing — but persisting it lets the poll-loop diff survive hibernation.
    migrateGlobalShapeSnapshot(sql);

    // Always present: a `.stream()` procedure can be declared `durable` without
    // a schema change, so the transcript tables have to exist before the first
    // one runs. Empty (and free) on a shard that never opens a durable stream.
    migrateDurableStreams(sql);

    return blocked ?? [];
};
