/**
 * Provisioning of `.global()` tables: read the catalog once, plan the DDL in memory, apply it in a few batches.
 *
 * Provisioning a database one statement at a time costs one round trip per statement — about nine per table, 368 for
 * a 42-table schema. On D1 every one is a network call from the Worker, so the first request after a deploy waited
 * a minute for work that is a handful of DDL statements. Nothing outside the store can batch it, because later
 * statements read what earlier ones created (the column probe, the index-shape check, the rewrite markers).
 *
 * The planner removes the dependency instead: it reads the catalog in at most two queries, decides per table what is missing,
 * and sends only the writes, through the exec's `batch` (an ordered, atomic transaction on D1). Anything it will not
 * decide in memory is handed to the original statement-at-a-time path, so the batched route can only ever do LESS
 * than the sequential one, never something different:
 *
 * - a table that needs an `ALTER` (a missing column, with its backfill),
 * - an index whose stored column list differs from the declared one (drop-and-recreate with a duplicate probe),
 * - an existing table whose legacy storage rewrites have not recorded their completion marker,
 * - a catalog read the engine refuses.
 *
 * A batch that fails (a `UNIQUE` index over rows that already violate it, say) is rolled back whole, and its tables run
 * the sequential path, which raises the same diagnostic it always did.
 *
 * SQLite-over-`batch` only. The Postgres and MySQL execs dispatch a batch concurrently rather than in order, so DDL
 * that depends on earlier DDL cannot ride it.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-global-provisioning" sits beside "ctx-db-migrations", the established module naming in this package. */

import type { SchemaLike } from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { GlobalIndexSpec, LegacyColumnRewrite } from "./ctx-db-migrations";
import {
    globalTableColumnsDdl,
    globalTableIndexSpecs,
    indexShapeChanged,
    legacyRewrites,
    legacyRowPredicate,
    MIGRATION_STATE_TABLE,
    provisionGlobalTablesSequentially,
    wantedGlobalColumns,
} from "./ctx-db-migrations";
import type { SqlDialect } from "./dialect";
import type { SqlCtxExec } from "./sql-exec";
import { queryAll, runInOrder } from "./sql-exec";

/**
 * Most statements sent in one `batch`. A table's statements are never split across two batches, so a batch holds whole
 * tables; 50 keeps each request small without making the sweep many round trips.
 */
const BATCH_STATEMENT_LIMIT = 50;

/**
 * An identifier as SQLite compares it: ASCII letters folded to lower case, everything else untouched. Not `toLowerCase()`,
 * which also folds non-ASCII letters that SQLite keeps distinct.
 */
const foldIdentifier = (name: string): string => name.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

/** What the database holds right now, as two catalog reads report it. All names are {@link foldIdentifier}-folded, because SQLite treats table, column and index names case-insensitively. */
interface Catalog {
    /** Column names per existing table, read from its stored `CREATE TABLE` text. */
    columns: ReadonlyMap<string, ReadonlySet<string>>;
    /** Stored `CREATE INDEX` text per existing index name (`undefined` for an implicit index the engine made). */
    indexes: ReadonlyMap<string, string | undefined>;
    /** Names recorded in {@link MIGRATION_STATE_TABLE}. */
    markers: ReadonlySet<string>;
    tables: ReadonlySet<string>;
}

const QUOTE_CLOSERS: ReadonlyMap<string, string> = new Map([
    ["'", "'"],
    ["[", "]"],
    ["`", "`"],
    ['"', '"'],
]);

const BARE_WORD = /^[\w$]+/u;

/** The index just past the quoted run that starts at `start`; a doubled closing quote is an escape (never inside `[ ]`). */
const skipQuoted = (text: string, start: number): number => {
    const closer = QUOTE_CLOSERS.get(text[start] as string) as string;
    let index = start + 1;

    while (index < text.length) {
        if (text[index] !== closer) {
            index += 1;
        } else if (closer !== "]" && text[index + 1] === closer) {
            index += 2;
        } else {
            return index + 1;
        }
    }

    return index;
};

/** The column an entry of a `CREATE TABLE` column list declares: its first word, unquoted. */
const nameOfEntry = (entry: string): string | undefined => {
    const text = entry.trim();
    const closer = QUOTE_CLOSERS.get(text[0] ?? "");

    if (closer === undefined) {
        return BARE_WORD.exec(text)?.[0];
    }

    const end = skipQuoted(text, 0);
    const body = text.slice(1, text[end - 1] === closer ? end - 1 : end);

    return closer === "]" ? body : body.replaceAll(`${closer}${closer}`, closer);
};

/**
 * The column names a stored `CREATE TABLE` statement declares: the first word of each top-level, comma-separated entry
 * inside its outermost parentheses, unquoted. Quotes (`"`, `'`, backtick, `[ ]`) and nested parentheses are skipped when
 * looking for the separators.
 *
 * This reads `sqlite_master` text rather than `PRAGMA table_info`, because D1's authorizer refuses the pragma
 * table-valued function when its argument is a column (`pragma_table_info(m.name)`) and a pragma per table is the round
 * trip this module exists to remove. `ALTER TABLE … ADD COLUMN` rewrites the stored text, so added columns appear here.
 *
 * A name this misses is only ever treated as MISSING, which hands the table to the sequential path: a wrong parse can cost
 * the speed-up, never correctness.
 */
const columnNamesOfCreateTable = (statement: string): Set<string> => {
    const names = new Set<string>();
    const note = (entry: string): void => {
        const name = nameOfEntry(entry);

        if (name !== undefined) {
            names.add(name);
        }
    };
    let depth = 0;
    let entryStart = 0;
    let index = 0;

    while (index < statement.length) {
        const character = statement[index] as string;

        if (QUOTE_CLOSERS.has(character)) {
            index = skipQuoted(statement, index);
            continue;
        }

        if (character === "(") {
            depth += 1;
            entryStart = depth === 1 ? index + 1 : entryStart;
        } else if (character === ")") {
            depth -= 1;

            if (depth === 0) {
                note(statement.slice(entryStart, index));

                return names;
            }
        } else if (character === "," && depth === 1) {
            note(statement.slice(entryStart, index));
            entryStart = index + 1;
        }

        index += 1;
    }

    return names;
};

/** The catalog, or `undefined` when the engine will not answer (the caller then provisions sequentially). */
const readCatalog = async (exec: SqlCtxExec, dialect: SqlDialect): Promise<Catalog | undefined> => {
    try {
        const objects = await queryAll(exec, dialect, sql`SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index')`);
        const tables = new Set<string>();
        const columns = new Map<string, Set<string>>();
        const indexes = new Map<string, string | undefined>();

        for (const row of objects) {
            const name = String(row["name"]);

            if (name.startsWith("sqlite_")) {
                continue;
            }

            const statement = typeof row["sql"] === "string" ? row["sql"] : undefined;

            if (row["type"] === "table") {
                tables.add(foldIdentifier(name));
                columns.set(
                    foldIdentifier(name),
                    new Set([...(statement === undefined ? [] : columnNamesOfCreateTable(statement))].map((column) => foldIdentifier(column))),
                );
            } else {
                indexes.set(foldIdentifier(name), statement);
            }
        }

        const markers = new Set<string>();

        if (tables.has(foldIdentifier(MIGRATION_STATE_TABLE))) {
            for (const row of await queryAll(exec, dialect, sql`SELECT name FROM ${sql.identifier(MIGRATION_STATE_TABLE)}`)) {
                markers.add(String(row["name"]));
            }
        }

        return { columns, indexes, markers, tables };
    } catch {
        return undefined;
    }
};

const createIndexStatement = (spec: GlobalIndexSpec): SQL => {
    const unique = spec.unique ? sql`UNIQUE ` : sql``;

    return sql`CREATE ${unique}INDEX IF NOT EXISTS ${sql.identifier(spec.name)} ON ${sql.identifier(spec.table)} (${spec.columns})`;
};

/**
 * The marker-table DDL and one guarded `INSERT OR IGNORE` per rewrite.
 *
 * The guard is part of the statement because "this table is new" is the one conclusion the planner takes from the catalog
 * rather than from the data. A catalog read that was stale (a read replica, a concurrent create) must not be able to record
 * a rewrite as finished over a table that exists and still holds legacy rows, so the marker is only written when no row
 * matches the rewrite's own legacy probe. On a genuinely empty new table it always writes.
 */
const markerStatements = (dialect: SqlDialect, tableName: string, rewrites: ReadonlyArray<LegacyColumnRewrite>): SQL[] =>
    rewrites.length === 0
        ? []
        : [
              sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(MIGRATION_STATE_TABLE)} (${sql.identifier("name")} ${sql.raw(dialect.companionTypes.key)} PRIMARY KEY)`,
              ...rewrites.map(
                  (rewrite) =>
                      sql`INSERT OR IGNORE INTO ${sql.identifier(MIGRATION_STATE_TABLE)} (${sql.identifier("name")}) SELECT ${rewrite.marker} WHERE NOT EXISTS (SELECT 1 FROM ${sql.identifier(tableName)} WHERE ${legacyRowPredicate(rewrite)})`,
              ),
          ];

/**
 * The writes one table needs, or `undefined` when the planner will not decide it in memory (see the file docblock).
 * An empty list means the table is already provisioned.
 */
const planTable = (tableName: string, definition: SchemaLike["tables"][string], dialect: SqlDialect, catalog: Catalog): SQL[] | undefined => {
    // Both throw the same VALIDATION_ERROR the sequential path does (a too-wide table, an unindexable unique index).
    const columnsDdl = globalTableColumnsDdl(tableName, definition, dialect);
    const specs = globalTableIndexSpecs(tableName, definition, dialect);
    const rewrites = legacyRewrites(tableName, definition);

    if (!catalog.tables.has(foldIdentifier(tableName))) {
        return [
            sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(tableName)} (${columnsDdl})`,
            ...specs.map((spec) => createIndexStatement(spec)),
            ...markerStatements(dialect, tableName, rewrites),
        ];
    }

    const present = catalog.columns.get(foldIdentifier(tableName)) ?? new Set<string>();

    if (wantedGlobalColumns(definition, dialect).some(([column]) => !present.has(foldIdentifier(column)))) {
        return undefined;
    }

    if (rewrites.some((rewrite) => !catalog.markers.has(rewrite.marker))) {
        return undefined;
    }

    const statements: SQL[] = [];

    for (const spec of specs) {
        if (!catalog.indexes.has(foldIdentifier(spec.name))) {
            statements.push(createIndexStatement(spec));
            continue;
        }

        const held = catalog.indexes.get(foldIdentifier(spec.name));

        if (spec.kind === "declared" && typeof held === "string" && indexShapeChanged(dialect, held, spec)) {
            return undefined;
        }
    }

    return statements;
};

interface Unit {
    statements: SQL[];
    table: string;
}

/** Pack whole tables into batches of at most {@link BATCH_STATEMENT_LIMIT} statements; one table larger than that gets a batch to itself. */
const packBatches = (units: ReadonlyArray<Unit>): Unit[][] => {
    const batches: Unit[][] = [];
    let current: Unit[] = [];
    let size = 0;

    for (const unit of units) {
        if (current.length > 0 && size + unit.statements.length > BATCH_STATEMENT_LIMIT) {
            batches.push(current);
            current = [];
            size = 0;
        }

        current.push(unit);
        size += unit.statements.length;
    }

    if (current.length > 0) {
        batches.push(current);
    }

    return batches;
};

/**
 * Auto-provision every `.global()` table from the schema, in as few round trips as the engine allows.
 *
 * `CREATE TABLE IF NOT EXISTS` with the physical `id`/`_creationTime`/row-version columns plus a typed column per declared
 * field, then its secondary, default-order and `.unique()` indexes. The D1 twin of `@lunora/do`'s `runShardMigrations`: it
 * makes the schema the single source of truth for global tables, so a fresh database serves them without a hand-applied
 * migration. Idempotent (`IF NOT EXISTS`, `OR IGNORE`), additive only: it never drops or retypes a column.
 *
 * With an exec that exposes `batch` on SQLite this reads the catalog once and writes the missing DDL in a handful of
 * atomic batches; otherwise, and for any table that needs more than additive DDL, it runs the original sequence.
 */
const runSqlGlobalTableMigrations = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    if (!exec.batch || dialect.name !== "sqlite") {
        await provisionGlobalTablesSequentially(exec, schema, dialect);

        return;
    }

    const catalog = await readCatalog(exec, dialect);

    if (catalog === undefined) {
        await provisionGlobalTablesSequentially(exec, schema, dialect);

        return;
    }

    const units: Unit[] = [];
    const deferred = new Set<string>();

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind !== "global") {
            continue;
        }

        const statements = planTable(tableName, definition, dialect, catalog);

        if (statements === undefined) {
            deferred.add(tableName);
        } else if (statements.length > 0) {
            units.push({ statements, table: tableName });
        }
    }

    for (const batch of packBatches(units)) {
        try {
            // eslint-disable-next-line no-await-in-loop -- one atomic batch at a time; a failed batch is retried sequentially before the next is sent.
            await runInOrder(
                exec,
                dialect,
                batch.flatMap((unit) => unit.statements),
            );
        } catch {
            // Rolled back whole. The sequential path re-derives each table and raises its own, better-worded error.
            for (const unit of batch) {
                deferred.add(unit.table);
            }
        }
    }

    await provisionGlobalTablesSequentially(exec, schema, dialect, deferred);
};

export { columnNamesOfCreateTable, runSqlGlobalTableMigrations };
