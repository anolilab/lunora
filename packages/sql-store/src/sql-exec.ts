/**
 * The engine-facing plumbing every `.global()` store module shares: the exec
 * seam, drizzle rendering, idempotent DDL, the row decoder, and the keyset page
 * walker.
 *
 * Extracted from `ctx-db.ts` so the store core is not the only place these can
 * live — `ctx-db-search.ts` needs the same primitives, and importing them from
 * `ctx-db.ts` would be a cycle. Mirrors how `@lunora/do` splits `do-exec` /
 * `do-sql` out from its own ctx-db.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "sql-exec" sits beside "ctx-db", the established module naming in this package. */
/* eslint-disable no-restricted-syntax -- `sql\`…\` here is the drizzle tagged-template SQL builder, not a string conversion; the rule misfires on the inner TemplateLiteral. */

import type { TableDefinitionLike } from "@lunora/do";
import { renderSql } from "@lunora/do";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { SqlDialect, SqlRunResult } from "./dialect";
import { effectiveColumnKind, sqliteDecode, sqliteEncode } from "./value-codec";

/** Logical field → physical column name (`_id`/`id` → `id`; everything else, incl. `_creationTime`, is itself). */
const physicalColumn = (field: string): string => (field === "_id" || field === "id" ? "id" : field);

/** Logical-field → physical column reference as a drizzle {@link SQL}; the engine's dialect quotes it at render time (`_id`/`id` → `id`). */
const columnRefSql = (field: string): SQL => sql`${sql.identifier(physicalColumn(field))}`;

/**
 * Run a composable drizzle {@link SQL} read through the (string-based) exec:
 * render it for the dialect's engine — quoting + placeholders handled by drizzle
 * — then run the resulting `{ sql, params }`. The exec interface is unchanged, so
 * D1/PlanetScale execs need no edits; the per-engine `?`→`$N` / `"…"`→backtick
 * rewrites become redundant once every site is on this path.
 */
const queryAll = (exec: SqlCtxExec, dialect: SqlDialect, query: SQL): Promise<Record<string, unknown>[]> => {
    const { params, sql: text } = renderSql(dialect.name, query);

    return exec.all(text, params);
};

/** Write twin of {@link queryAll}: render a drizzle {@link SQL} for the engine and run it. */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- `void` is intentional: mirrors SqlExec.run, whose union accepts a void-returning exec (no affected-rows count)
const queryRun = (exec: SqlCtxExec, dialect: SqlDialect, query: SQL): Promise<SqlRunResult | void> => {
    const { params, sql: text } = renderSql(dialect.name, query);

    return exec.run(text, params);
};

/**
 * Create an index idempotently across engines. SQLite/Postgres support
 * `CREATE [UNIQUE] INDEX IF NOT EXISTS`; **MySQL does not** (only `CREATE TABLE`
 * takes `IF NOT EXISTS`), so it creates unconditionally and swallows the
 * "duplicate key name" error (errno 1061) a re-run raises.
 */
const createIndexIfNotExists = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    spec: { columns: SQL; name: string; table: string; unique: boolean },
): Promise<void> => {
    const unique = spec.unique ? sql`UNIQUE ` : sql``;

    if (dialect.name === "mysql") {
        try {
            await queryRun(exec, dialect, sql`CREATE ${unique}INDEX ${sql.identifier(spec.name)} ON ${sql.identifier(spec.table)} (${spec.columns})`);
        } catch (error) {
            // ER_DUP_KEYNAME. Drivers disagree on which field carries it —
            // mysql2 sets `errno`, others only the symbolic `code` — so accept
            // either rather than rethrowing a re-run of idempotent DDL.
            const duplicate = error as { code?: unknown; errno?: unknown };

            if (duplicate.errno !== 1061 && duplicate.code !== "ER_DUP_KEYNAME" && duplicate.code !== 1061) {
                throw error;
            }
        }

        return;
    }

    await queryRun(exec, dialect, sql`CREATE ${unique}INDEX IF NOT EXISTS ${sql.identifier(spec.name)} ON ${sql.identifier(spec.table)} (${spec.columns})`);
};

/**
 * Async SQL surface the D1 ORM needs: `all` for reads, `run` for writes.
 * Satisfied by a `D1Session`/`D1Client` in production and a `node:sqlite`
 * adapter in tests, so the query logic runs against a real SQLite engine.
 */
interface SqlCtxExec {
    all: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
    // `void` for D1/node:sqlite (the result is ignored on those paths); a
    // `SqlRunResult` ({ rowsAffected }) for engines whose OCC needs the affected
    // count (MySQL, which has no `RETURNING`). The union lets a PlanetScale
    // `SqlExec` satisfy this without forcing the D1 execs to report a count.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- `void` is intentional: accepts a void-returning exec (one that reports no affected-rows count)
    run: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<SqlRunResult | void>;
}

/** SQLite storage encode for `.global()` column values — the shared `@lunora/sql-store` codec (SQLite has no boolean, so true/false → 1/0). */
const serializeColumnValue: (value: unknown) => unknown = sqliteEncode;

/**
 * Memoized per-`SqlCtxExec` FTS5 capability probe. D1's SQLite ships FTS5;
 * `node:sqlite` (used in tests) does not. We create and drop a throwaway virtual
 * table once per handle and cache the resolving promise — the exec handle is
 * stable for the ctx-db's lifetime, so this runs at most once per binding. The
 * cached value is a `Promise` so concurrent first-callers share the single probe
 * rather than racing two CREATE/DROP round-trips.
 */
const ftsAvailabilityCache = new WeakMap<SqlCtxExec, Promise<boolean>>();

const isFtsAvailable = (exec: SqlCtxExec, dialect?: SqlDialect): Promise<boolean> => {
    // fts5 is a SQLite module. On Postgres and MySQL the probe below is a DDL
    // statement that is *guaranteed* to fail — a wasted round trip on every
    // fresh connection plus an error in the database's log — so answer from the
    // dialect and never issue it.
    if (dialect && dialect.name !== "sqlite") {
        return Promise.resolve(false);
    }

    const cached = ftsAvailabilityCache.get(exec);

    if (cached !== undefined) {
        return cached;
    }

    const probe = (async (): Promise<boolean> => {
        let available: boolean;

        try {
            await exec.run(`CREATE VIRTUAL TABLE IF NOT EXISTS "__lunora_fts_probe" USING fts5(x)`, []);
            available = true;
        } catch {
            available = false;
        } finally {
            // Always attempt the DROP so the probe table never lingers — if the
            // CREATE threw, the IF EXISTS makes the DROP a no-op.
            try {
                await exec.run(`DROP TABLE IF EXISTS "__lunora_fts_probe"`, []);
            } catch {
                // The probe table cleanup is best-effort; swallow so the
                // availability decision still propagates.
            }
        }

        return available;
    })();

    ftsAvailabilityCache.set(exec, probe);

    return probe;
};

/**
 * The `field → effective column kind` mapping for a table, derived once per
 * (immutable) definition and memoized. `effectiveColumnKind` is pure over the
 * validator and the shape never mutates after `defineSchema`, so the mapping is
 * static per definition — precomputing it removes the per-row
 * `Object.entries(definition.shape)` + `effectiveColumnKind` recomputation on the
 * decode hot path (a page/global read decodes R rows × M columns). Keyed on the
 * definition object identity (stable: definitions come from `defineSchema`).
 */
const columnKindCache = new WeakMap<TableDefinitionLike, [string, string | undefined][]>();

const columnKinds = (definition: TableDefinitionLike): [string, string | undefined][] => {
    let kinds = columnKindCache.get(definition);

    if (kinds === undefined) {
        kinds = Object.entries(definition.shape).map(([field, validator]) => [field, effectiveColumnKind(validator)] as [string, string | undefined]);
        columnKindCache.set(definition, kinds);
    }

    return kinds;
};

/**
 * Decode a SELECTed row back into a document: `id` → `_id`, `_creationTime`
 * preserved, and every column run through the shared {@link sqliteDecode} so the
 * stored form is reversed back into its JS shape. Exported so the data-browser
 * (`introspect.ts`) and admin export/import paths share the exact same decode.
 *
 * The decode is engine-agnostic: every backend stores SQLite-shaped values
 * (boolean → 1/0, JSON → text, bigint → decimal string), and `sqliteDecode` is
 * robust to a driver returning either the stored string OR a natively-parsed
 * value (e.g. mysql2 returns JSON columns pre-parsed) — so the same decoder is
 * correct on SQLite, Postgres and MySQL.
 */
const decodeGlobalRow = (definition: TableDefinitionLike, row: Record<string, unknown>): Record<string, unknown> => {
    const decoded: Record<string, unknown> = {};

    for (const [field, kind] of columnKinds(definition)) {
        const raw = row[field];

        if (raw === undefined) {
            continue;
        }

        decoded[field] = sqliteDecode(raw, kind);
    }

    decoded["_id"] = row["id"];
    decoded["_creationTime"] = row["_creationTime"];

    return decoded;
};

/** Decode a SELECTed row back into a document, or `null` when the row is absent. */

const decodeRow = (definition: TableDefinitionLike, row: Record<string, unknown> | undefined): Record<string, unknown> | null => {
    if (!row) {
        // eslint-disable-next-line unicorn/no-null -- a missing row decodes to `null`, the value writer.get() returns per the public DatabaseWriterLike contract.
        return null;
    }

    return decodeGlobalRow(definition, row);
};

/** Decode a result set into documents, dropping any row that fails to decode. */
const decodeRows = (definition: TableDefinitionLike, rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown>[] => {
    const documents: Record<string, unknown>[] = [];

    for (const row of rows) {
        const decoded = decodeRow(definition, row);

        if (decoded) {
            documents.push(decoded);
        }
    }

    return documents;
};

/** Fixed page size for the keyset-paged table scans the backfill helpers use. */
const BACKFILL_BATCH_SIZE = 500;

/**
 * Stream rows of `tableName` to `onDoc` in `id`-keyset order, decoding each row
 * into a document first. Pages by the last row's `id` (not OFFSET) so an
 * unbounded table never has to fit in a single result buffer. Rows that fail to
 * decode are skipped. Shared by the aggregate-, rank-counter and search-index
 * backfills.
 *
 * `options.after` resumes past an id already handled and `options.limit` bounds
 * the walk — together they let the search backfill index a table one bounded
 * page per pass instead of blocking a request behind a full-table scan. Absent,
 * the walk covers the whole table.
 *
 * `onDoc` may return a promise (the search backfill writes companion rows per
 * document); it is awaited before the next row, keeping companion writes
 * sequential on the shared connection like every other write path here.
 */
const forEachRowPaged = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    onDoc: (document: Record<string, unknown>) => Promise<void> | void,
    options: { after?: string; limit?: number } = {},
): Promise<void> => {
    let cursorId: string | undefined = options.after;
    let remaining = options.limit;
    let hasMore = true;

    while (hasMore && (remaining === undefined || remaining > 0)) {
        const pageSize = remaining === undefined ? BACKFILL_BATCH_SIZE : Math.min(BACKFILL_BATCH_SIZE, remaining);
        const pageRows =
            cursorId === undefined
                ? // eslint-disable-next-line no-await-in-loop -- keyset paging is inherently sequential: each page's WHERE depends on the prior page's last id.
                  await queryAll(
                      exec,
                      dialect,
                      sql`SELECT * FROM ${sql.identifier(tableName)} ORDER BY ${sql.identifier("id")} ASC LIMIT ${sql.raw(String(pageSize))}`,
                  )
                : // eslint-disable-next-line no-await-in-loop -- keyset paging is inherently sequential: each page's WHERE depends on the prior page's last id.
                  await queryAll(
                      exec,
                      dialect,
                      sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ${sql.identifier("id")} > ${cursorId} ORDER BY ${sql.identifier("id")} ASC LIMIT ${sql.raw(String(pageSize))}`,
                  );

        for (const row of pageRows) {
            const decoded = decodeRow(definition, row);

            if (decoded) {
                // eslint-disable-next-line no-await-in-loop -- an async `onDoc` (the search backfill) writes companion rows on the single shared connection; sequential is the point.
                await onDoc(decoded);
            }
        }

        cursorId = pageRows.at(-1)?.["id"] as string | undefined;
        hasMore = pageRows.length === pageSize;
        remaining = remaining === undefined ? undefined : remaining - pageRows.length;
    }
};

export type { SqlCtxExec };
export {
    BACKFILL_BATCH_SIZE,
    columnRefSql,
    createIndexIfNotExists,
    decodeGlobalRow,
    decodeRow,
    decodeRows,
    forEachRowPaged,
    isFtsAvailable,
    physicalColumn,
    queryAll,
    queryRun,
    serializeColumnValue,
};
