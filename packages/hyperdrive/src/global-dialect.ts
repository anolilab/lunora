/**
 * The Hyperdrive-backed {@link SqlDialect}s — Postgres and MySQL — for driving a
 * Lunora `.global()` store over Cloudflare Hyperdrive.
 *
 * Both mirror `@lunora/d1`'s `sqliteDialect`, differing only where the engines
 * genuinely diverge: column types, the catalog probe, unique-violation
 * detection, `RETURNING` support, and the MySQL index key-prefix. Every backend
 * stores **SQLite-shaped values** (boolean → 1/0, JSON → text/json, bigint →
 * decimal string), so the value codec is shared (`sqliteEncode`/`sqliteDecode`)
 * — `sqliteDecode` is robust to a driver returning either the stored string or a
 * natively-parsed value (e.g. mysql2 returns JSON pre-parsed, node-postgres
 * returns bigint as a string).
 *
 * Identifier quoting, placeholder numbering, upserts and NULL-safe equality are
 * NOT dialect members — the store core builds every statement through drizzle's
 * matching dialect (selected off `name`), which emits `$N`/`?` placeholders and
 * `"…"`/`` `…` `` identifiers per engine. These dialects only carry what drizzle
 * can't infer from a dynamic, column-per-field schema.
 */
import type { SqlDialect } from "@lunora/sql-store";
import { sqliteDecode, sqliteEncode } from "@lunora/sql-store";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

/** Companion columns for the Postgres native layout: the document id and its indexed vector. */
const VECTOR_ID_COLUMN = "__id__";
const VECTOR_COLUMN = "__vector__";

/** The companion's vector column, qualified by the alias the reader joins under. */
const vectorRef = (companion: string): SQL => sql`${sql.identifier(companion)}.${sql.identifier(VECTOR_COLUMN)}`;

/**
 * Build the stored vector from an already-analyzed token stream.
 *
 * `simple` is deliberate on three counts: it applies no stemming or stopword
 * list of its own (Lunora's analyzer already did that, and a second pass would
 * disagree with every other backend), it makes `to_tsvector`/`to_tsquery`
 * IMMUTABLE rather than STABLE — which is what lets Hyperdrive cache the read —
 * and it keeps the stored vector a pure function of the tokens we hand it.
 */
const toVector = (analyzed: string): SQL => sql`to_tsvector('simple', ${analyzed})`;

/** The query form of the same: every term ANDed, the final one as a prefix so it matches as-you-type. */
const toQuery = (terms: ReadonlyArray<string>): SQL =>
    sql`to_tsquery('simple', ${terms.map((term, index) => (index === terms.length - 1 ? `${term}:*` : term)).join(" & ")})`;

/** Postgres unique-violation message (the SQLSTATE 23505 fallback when the driver omits `.code`). */
const PG_UNIQUE_VIOLATION_RE = /duplicate key value violates unique constraint/iu;

/** MySQL storage type for a validator `kind`. Shared by `columnType` and the index-prefix decision below. */
const mysqlColumnType = (kind: string | undefined): string => {
    switch (kind) {
        case "array":
        case "object":
        case "record": {
            return "JSON";
        }
        case "bigint": {
            // stored as a decimal string (max 20 digits — never truncates).
            return "VARCHAR(64)";
        }
        case "boolean": {
            return "TINYINT";
        }
        case "bytes": {
            return "LONGBLOB";
        }
        case "date":
        case "number":
        case "timestamp": {
            return "DOUBLE";
        }
        default: {
            // string/id/literal/union/any → unbounded text so a value never
            // truncates; `indexKeyPrefix` adds a key prefix wherever one is indexed.
            return "LONGTEXT";
        }
    }
};

/** TEXT/BLOB-family columns InnoDB can't index without a prefix length. */
const MYSQL_PREFIX_INDEX_RE = /TEXT|BLOB/u;

/**
 * **Postgres** dialect. Differs from SQLite only in column types
 * (`DOUBLE PRECISION`/`BYTEA`/`BIGSERIAL`), the `information_schema` catalog
 * probe, and unique-violation detection (SQLSTATE `23505`).
 */
export const postgresDialect: SqlDialect = {
    companionTypes: {
        autoincrementPrimaryKey: "BIGSERIAL PRIMARY KEY",
        integer: "INTEGER",
        key: "TEXT",
        real: "DOUBLE PRECISION",
        text: "TEXT",
    },
    columnType: (kind) => {
        switch (kind) {
            case "boolean": {
                // booleans store as 1/0 (shared encode) in an INTEGER column.
                return "INTEGER";
            }
            case "bytes": {
                return "BYTEA";
            }
            case "date":
            case "number":
            case "timestamp": {
                return "DOUBLE PRECISION";
            }
            default: {
                // string/id/literal, bigint (decimal string), object/array/record/union/any (JSON text).
                return "TEXT";
            }
        }
    },
    decode: (value, kind) => sqliteDecode(value, kind),
    encode: (value) => sqliteEncode(value),
    frameworkColumns: () => [
        { name: "id", type: "TEXT PRIMARY KEY" },
        { name: "_creationTime", type: "DOUBLE PRECISION NOT NULL" },
    ],
    isUniqueViolation: (error) => {
        const { code } = error as { code?: unknown };

        return code === "23505" || (error instanceof Error && PG_UNIQUE_VIOLATION_RE.test(error.message));
    },
    name: "postgres",
    supportsFts5: false,

    /**
     * Postgres full text, opted into per index with `strategy: "native"`.
     *
     * The `simple` configuration is deliberate on three counts: it applies no
     * stemming or stopword list of its own (Lunora's analyzer already did that,
     * and a second pass would disagree with every other backend), it makes
     * `to_tsvector`/`to_tsquery` IMMUTABLE rather than STABLE — which is what
     * lets Hyperdrive cache the read — and it keeps the stored vector a pure
     * function of the tokens we hand it.
     *
     * The final term gets `:*` so a native index prefix-matches as-you-type,
     * matching what the portable path does with `LIKE`.
     */
    nativeTextSearch: {
        createCompanion: (companion, keyType) =>
            sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(companion)} (${sql.identifier(VECTOR_ID_COLUMN)} ${sql.raw(keyType)} PRIMARY KEY, ${sql.identifier(VECTOR_COLUMN)} tsvector)`,
        createIndexes: (companion) => [
            sql`CREATE INDEX IF NOT EXISTS ${sql.identifier(`${companion}__gin`)} ON ${sql.identifier(companion)} USING GIN (${sql.identifier(VECTOR_COLUMN)})`,
        ],
        indexDocument: (companion, id, analyzed) =>
            sql`INSERT INTO ${sql.identifier(companion)} (${sql.identifier(VECTOR_ID_COLUMN)}, ${sql.identifier(VECTOR_COLUMN)}) VALUES (${id}, ${toVector(analyzed)})`,
        matches: (companion, terms) => sql`${vectorRef(companion)} @@ ${toQuery(terms)}`,
        rank: (companion, terms) => sql`ts_rank_cd(${vectorRef(companion)}, ${toQuery(terms)})`,
    },
    supportsReturning: true,

    // The search companion's token btree is scanned with `LIKE 'prefix%'` for a
    // query's final term. A default `text_ops` btree built under a linguistic
    // collation (e.g. `en_US.UTF-8`) can't answer that, so the token index
    // declares the pattern operator class and the scan stays indexed.
    textPatternOperatorClass: "text_pattern_ops",

    // Restrict to schemas on the effective search_path (excluding the implicit
    // pg_catalog with `false`) so an unqualified name resolves exactly as CREATE
    // TABLE / SELECT would. Without this filter the probe sees same-named tables in
    // OTHER schemas of the same database (a common multi-tenant/multi-env Hyperdrive
    // setup), reporting a companion table that does not exist on the search_path.
    tableExists: (table) => sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ANY (current_schemas(false)) AND table_name = ${table}`,
};

/**
 * **MySQL** dialect. Diverges in: **no `RETURNING`** (the store's OCC falls back
 * to affected-rows — which requires the connection's `CLIENT_FOUND_ROWS` flag so
 * a no-op update still reports a matched row, see `buildMysqlExec`); bounded
 * `VARCHAR` keys (TEXT can't be a primary key / unindexed); a TEXT/BLOB index key
 * prefix; and `ER_DUP_ENTRY` (errno 1062) unique violations. (Drizzle's MySQL
 * dialect supplies the backtick identifiers + `ON DUPLICATE KEY` upserts.)
 */
export const mysqlDialect: SqlDialect = {
    affectedRows: (result) => result.rowsAffected,
    companionTypes: {
        autoincrementPrimaryKey: "BIGINT AUTO_INCREMENT PRIMARY KEY",
        integer: "INTEGER",
        // VARCHAR so it can be a PRIMARY KEY and be fully indexed (TEXT cannot,
        // without a prefix length). 768 = InnoDB utf8mb4 single-column index limit.
        key: "VARCHAR(768)",
        real: "DOUBLE",
        // Unbounded post-image storage (CDC `doc`); never an index key, so no bound.
        text: "LONGTEXT",
    },
    columnType: (kind) => mysqlColumnType(kind),
    decode: (value, kind) => sqliteDecode(value, kind),
    encode: (value) => sqliteEncode(value),
    frameworkColumns: () => [
        { name: "id", type: "VARCHAR(768) PRIMARY KEY" },
        { name: "_creationTime", type: "DOUBLE NOT NULL" },
    ],
    // InnoDB can't index a TEXT/LONGTEXT/BLOB column without a key prefix. Bound it
    // to 191 chars (191 × 4 = 764 bytes under utf8mb4), matching the rank-companion
    // convention: a flat 768-char prefix is 3072 bytes — exactly InnoDB's whole-index
    // key limit — so ANY composite index containing a string field (e.g.
    // `.index("by_project", ["projectId", "seq"])`) would exceed 3072 and fail CREATE
    // INDEX with ER_TOO_LONG_KEY. 191 leaves room for several columns under the cap.
    indexKeyPrefix: (kind) => (MYSQL_PREFIX_INDEX_RE.test(mysqlColumnType(kind)) ? 191 : undefined),
    isUniqueViolation: (error) => {
        const candidate = error as { code?: unknown; errno?: unknown };

        return candidate.errno === 1062 || candidate.code === "ER_DUP_ENTRY";
    },
    name: "mysql",
    supportsFts5: false,
    supportsReturning: false,

    tableExists: (table) => sql`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ${table}`,
};
