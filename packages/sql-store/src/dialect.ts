/**
 * The `SqlDialect` seam — the small per-engine value object that lets one ORM
 * core (`createSqlCtxDb`) drive a `.global()` table store on **any** SQL engine
 * (SQLite/D1, Postgres, MySQL via Hyperdrive).
 *
 * The store core builds every statement as a composable drizzle `SQL` and
 * renders it through drizzle's matching dialect (selected off {@link SqlDialect.name}),
 * so identifier quoting, placeholder numbering, upserts, and NULL-safe equality
 * are handled by drizzle — not this object. What remains are the decisions
 * drizzle can't infer from a dynamic, column-per-field schema: column/companion
 * types, value encode/decode, `RETURNING` support + affected-rows, unique-
 * violation detection, the MySQL index key-prefix, and the catalog probe.
 *
 * Pure — no runtime dependency on `@lunora/do` or a SQL driver.
 */
import type { SQL } from "drizzle-orm";

/** Outcome of a non-`SELECT` statement: the row count it changed (for MySQL OCC, which lacks `RETURNING`). */
export interface SqlRunResult {
    /** Rows the statement inserted/updated/deleted. `0` when the engine can't report it. */
    rowsAffected: number;
}

/**
 * The async SQL surface the store core consumes. Satisfied by a
 * `D1Session`/`D1Client` (D1), a `node:sqlite` adapter (tests), or a
 * Hyperdrive-backed `postgres`/`pg`/`mysql2` driver (PlanetScale).
 *
 * `all` runs a row-returning statement (incl. `... RETURNING ...`); `run` runs a
 * write and reports `rowsAffected` — the matched-rows count that drives the
 * MySQL optimistic-concurrency guard (which has no `RETURNING`).
 *
 * Note: companion writes (aggregate/rank/FTS/CDC) run as separate sequential
 * statements after the row write on every engine, so they share D1's
 * at-least-once caveat — there is no cross-statement transaction here.
 */
export interface SqlExec {
    all: (sql: string, params: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
    run: (sql: string, params: ReadonlyArray<unknown>) => Promise<SqlRunResult>;
}

/** Everything engine-specific the store core needs. One value per engine; `sqliteDialect` (in `@lunora/d1`) is the reference, Postgres/MySQL live in `@lunora/hyperdrive/global`. */
export interface SqlDialect {
    /** Affected-rows extractor for the OCC fallback when `supportsReturning` is false (MySQL). */
    affectedRows?: (result: SqlRunResult) => number;

    /**
     * Storage SQL column type for a validator `kind`. SQLite affinity
     * (`TEXT`/`INTEGER`/`REAL`/`BLOB`); Postgres `TEXT`/`DOUBLE PRECISION`/
     * `BOOLEAN`/`JSONB`/`BYTEA`; MySQL `VARCHAR(255)`/`TEXT`/`DOUBLE`/
     * `TINYINT(1)`/`JSON`/`LONGBLOB`.
     */
    columnType: (kind: string | undefined) => string;

    /**
     * Engine SQL types for the **internal companion tables** (aggregate / rank /
     * CDC), which are built from raw SQL types, not validator kinds. SQLite uses
     * `TEXT`/`REAL`/`INTEGER`/`BLOB` and `INTEGER PRIMARY KEY AUTOINCREMENT`;
     * Postgres `TEXT`/`DOUBLE PRECISION`/`INTEGER`/`BYTEA` + `BIGSERIAL`; MySQL
     * needs a bounded `VARCHAR` key, `DOUBLE`, `LONGBLOB`, `AUTO_INCREMENT`.
     */
    companionTypes: {
        // Auto-incrementing primary-key column declaration (the full "<type> PRIMARY KEY ...").
        autoincrementPrimaryKey: string;
        // Integer column (counts).
        integer: string;
        // Primary-key/string column (companion __key__/__id__/__partition__).
        key: string;
        // Floating-point column (aggregate __value__).
        real: string;
        // Unbounded text column (the CDC post-image `doc` — arbitrary-size JSON
        // that must never truncate). MySQL `LONGTEXT` vs the index-bounded `key`.
        text: string;
    };

    /**
     * Map a stored value back to its JS form, by effective validator `kind`
     * (inverse of `encode`). NOTE: currently **unused** by the store core, which
     * hard-codes `sqliteDecode` in `decodeGlobalRow` on every engine. Kept on the
     * seam for a future engine-native codec; an override here does not run today.
     */
    decode: (value: unknown, kind: string | undefined) => unknown;

    /**
     * Map a JS value to its bound storage form (boolean→1/0, bigint→string,
     * object→JSON on SQLite). NOTE: currently **unused** by the store core, which
     * hard-codes `sqliteEncode` as `serializeColumnValue` on every engine. Kept on
     * the seam for a future engine-native codec; an override here does not run today.
     */
    encode: (value: unknown) => unknown;
    /** The framework columns every global table carries — the `id` primary key and `_creationTime` — as `{ name, type }` so the DDL builder can quote each name through the engine's dialect. */
    frameworkColumns: () => ReadonlyArray<{ name: string; type: string }>;

    /**
     * Optional: the key-prefix length an indexed column of this `kind` needs.
     * MySQL/InnoDB can't index a `TEXT`/`LONGTEXT`/`BLOB` column without a prefix
     * (the store appends `(&lt;n>)` to the column reference); SQLite/Postgres index
     * text columns directly and omit this hook (or return `undefined`). `kind` is
     * the column's effective validator kind.
     */
    indexKeyPrefix?: (kind: string | undefined) => number | undefined;
    /** True when an `error` thrown by a write is a UNIQUE-constraint breach (mapped to a 409 ConflictError). */
    isUniqueViolation: (error: unknown) => boolean;

    /** A short engine tag for diagnostics/branching (`"sqlite" | "postgres" | "mysql"`). The store core selects drizzle's matching dialect for rendering off this. */
    readonly name: "mysql" | "postgres" | "sqlite";

    /**
     * Optional: the engine's own full-text index, opted into per search index
     * with `.searchIndex({ strategy: "native" })`.
     *
     * Only Postgres supplies one today (`tsvector` + GIN + `to_tsquery`). It
     * scales sublinearly where the portable inverted companion aggregates every
     * matching token row, but it ranks with the engine's formula rather than the
     * shared scorer — which is why it is opt-in and why the parity suite asserts
     * matching, not order, for indexes that use it.
     *
     * Recall still matches the portable path: the stored vector is built from
     * the tokens Lunora's analyzer already produced, with a config (`simple`)
     * that adds no stemming or stopwords of the engine's own.
     */
    nativeTextSearch?: {
        /** DDL for the column holding the indexed vector. */
        columnType: string;
        /** Index method for that column (`GIN`). */
        indexMethod: string;
        /** Rank expression, best first. */
        rank: (column: SQL, query: SQL) => SQL;
        /** Build the match predicate for a query's analyzed terms, final term as a prefix. */
        toQuery: (terms: ReadonlyArray<string>) => SQL;
        /** Build the stored vector from an already-analyzed token stream. */
        toVector: (bound: SQL) => SQL;
    };

    /** True when the engine supports `UPDATE/DELETE ... RETURNING` (SQLite/PG yes, MySQL no → use `affectedRows`). */
    supportsReturning: boolean;

    /**
     * The catalog probe for whether a physical `table` exists — backs the opt-in
     * companion-table (`__agg_`/`__rank_`) existence checks. Returns a drizzle
     * {@link SQL} (a non-empty result ⇒ the table exists) so it renders through
     * the same per-engine path as every other statement, never a hand-built
     * placeholder string. SQLite reads `sqlite_master`; Postgres/MySQL read
     * `information_schema.tables`.
     */
    tableExists: (table: string) => SQL;

    /**
     * Optional: btree operator class appended to an indexed text column so a
     * `LIKE 'prefix%'` scan can use the index whatever the database collation.
     * Postgres needs `text_pattern_ops` (a default `text_ops` btree built under
     * e.g. `en_US.UTF-8` is useless to `LIKE`); SQLite and MySQL index prefix
     * matches off the plain index and omit this. Only the search companion's
     * token index reads it.
     */
    textPatternOperatorClass?: string;
}
