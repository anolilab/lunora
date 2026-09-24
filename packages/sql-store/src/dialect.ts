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

    /**
     * Optional: run several write statements as one round trip instead of
     * `run()` called once per statement in sequence. Statements MUST be
     * mutually independent — an implementation MAY reorder or parallelize
     * across elements, so callers must never rely on array order between
     * elements (e.g. a purge-then-insert pair belongs in separate sequential
     * `queryRun`/`run` calls, not one `batch`).
     *
     * Absent, the store core falls back to its historical sequential `run()`
     * loop, so an exec that doesn't implement this keeps working unchanged.
     *
     * D1's `client.batch` executes the whole array atomically (all-or-nothing)
     * in one request, preserving array order — an actual atomicity improvement
     * over the sequential fallback, not just a round-trip one. The Hyperdrive
     * `postgres`/`pg` adapters instead dispatch every statement concurrently
     * (`Promise.all`) over the same connection/pool rather than awaiting each
     * in turn — still "at-least-once, non-atomic" like the fallback, but no
     * longer serialized one full RTT at a time, and with no ordering between
     * elements. Safe only for statements whose effects don't depend on each
     * other (distinct-keyed rows), which is what every current caller batches.
     */
    batch?: (statements: ReadonlyArray<{ params: ReadonlyArray<unknown>; sql: string }>) => Promise<void>;
    run: (sql: string, params: ReadonlyArray<unknown>) => Promise<SqlRunResult>;
}

/** Everything engine-specific the store core needs. One value per engine; `sqliteDialect` (in `@lunora/d1`) is the reference, Postgres/MySQL live in `@lunora/hyperdrive/global`. */
export interface SqlDialect {
    /** Affected-rows extractor for the OCC fallback when `supportsReturning` is false (MySQL). */
    affectedRows?: (result: SqlRunResult) => number;

    /**
     * Storage SQL column type for a validator `kind`. Every engine stores
     * SQLite-shaped values (see `value-codec.ts`), so the types are the ones
     * those forms fit, not the engine's richest equivalent:
     *
     * - SQLite affinity: `TEXT`/`INTEGER`/`REAL`/`BLOB`.
     * - Postgres: `DOUBLE PRECISION` (number/date/timestamp), `BYTEA` (bytes),
     *   `INTEGER` (boolean, stored 1/0), `TEXT` for everything else — including
     *   the composites, which are JSON text rather than `JSONB`.
     * - MySQL: `DOUBLE`, `LONGBLOB`, `TINYINT`, `VARCHAR(64)` (bigint as a
     *   decimal string), and `LONGTEXT` for everything else — strings unbounded
     *   so they never truncate, composites because their wire-marked form is not
     *   valid JSON and a `JSON` column would reject it on insert.
     *
     * `unique` says the column carries a `.unique()` constraint, so the type has
     * to be one the engine can index in FULL. It exists for MySQL: InnoDB cannot
     * index a `LONGTEXT` without a key prefix, and a prefixed UNIQUE index
     * enforces uniqueness of the PREFIX — two distinct 200-character emails
     * sharing their first 191 characters collided as a duplicate. A bounded
     * `VARCHAR` indexes whole, so the constraint means what it says; a value
     * past the bound is a loud write error rather than a wrong conflict. SQLite
     * and Postgres index text of any length and ignore the flag.
     */
    columnType: (kind: string | undefined, options?: { unique?: boolean }) => string;

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

    /** The framework columns every global table carries — the `id` primary key and `_creationTime` — as `{ name, type }` so the DDL builder can quote each name through the engine's dialect. */
    frameworkColumns: () => ReadonlyArray<{ name: string; type: string }>;

    /**
     * Optional: the key-prefix length an indexed column of this `kind` needs.
     * MySQL/InnoDB can't index a `TEXT`/`LONGTEXT`/`BLOB` column without a prefix
     * (the store appends `(<n>)` to the column reference); SQLite/Postgres index
     * text columns directly and omit this hook (or return `undefined`). `kind` is
     * the column's effective validator kind.
     */
    indexKeyPrefix?: (kind: string | undefined) => number | undefined;

    /** True when an `error` thrown by a write is a UNIQUE-constraint breach (mapped to a 409 ConflictError). */
    isUniqueViolation: (error: unknown) => boolean;

    /**
     * Most columns one table may carry on this engine, framework columns
     * included. Omit it and the DDL builder does not check — the right answer
     * for an engine whose ceiling is high enough that no real schema reaches it.
     *
     * Declared because the ceilings differ by more than an order of magnitude:
     * D1 runs Workerd's SQLite build, which caps a table at 100 columns, where
     * Postgres allows 1,600 and MySQL 4,096. A fixed number here would either
     * miss the D1 failure or reject schemas the other two engines run happily.
     */
    maxTableColumns?: number;

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
     * Recall still matches the portable path: the stored form is built from the
     * tokens Lunora's analyzer already produced, under a configuration that adds
     * no stemming or stopwords of the engine's own.
     *
     * Every member returns a *statement*, not a fragment, so no engine grammar
     * reaches the store core: Postgres matches with `@@` against a `tsvector`
     * column while MySQL would use `MATCH … AGAINST` against a text column, and
     * both fit here without the caller knowing which.
     */
    nativeTextSearch?: {
        /** DDL for the companion table holding the engine's indexed form, keyed by document id. */
        createCompanion: (companion: string, keyType: string) => SQL;
        /** DDL for the indexes that make the match fast. */
        createIndexes: (companion: string) => SQL[];
        /** Replace one document's row, given its already-analyzed token stream. */
        indexDocument: (companion: string, id: string, analyzed: string) => SQL;
        /** The `WHERE` predicate matching a query's analyzed terms, final term as a prefix. */
        matches: (companion: string, terms: ReadonlyArray<string>) => SQL;
        /** The `ORDER BY` expression, best first. */
        rank: (companion: string, terms: ReadonlyArray<string>) => SQL;
    };

    /**
     * True when the engine ships SQLite's FTS5 module, which decides whether a
     * search index is stored as an FTS5 shadow or as the portable inverted
     * companion.
     *
     * A static property of the engine, so it is declared rather than probed:
     * the previous `CREATE VIRTUAL TABLE` capability probe spent a round trip
     * (and an error in the database's log) on every fresh connection to
     * rediscover something the dialect already knows. Tests that want the
     * portable layout override this instead of intercepting SQL strings.
     */
    supportsFts5: boolean;

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
