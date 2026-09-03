/**
 * The Hyperdrive-backed {@link SqlDialect}s — Postgres and MySQL — for driving a
 * Lunora `.global()` store over Cloudflare Hyperdrive.
 *
 * Both mirror `@lunora/d1`'s `sqliteDialect`, differing only where the engines
 * genuinely diverge: column types, the catalog probe, unique-violation
 * detection, the MySQL index key-prefix, and the MySQL column collation (see
 * {@link MYSQL_COLLATION} — the server default folds case and accents, which the
 * other two engines do not). Every backend stores **SQLite-shaped values**
 * (boolean → 1/0, composites → JSON text, bigint → an order-preserving text key)
 * through the store core's own `sqliteEncode`/`sqliteDecode`,
 * which is not a dialect member — `sqliteDecode` is robust to a driver returning
 * either the stored string or a natively-parsed value (e.g. node-postgres
 * returns bigint as a string).
 *
 * Identifier quoting, placeholder numbering, upserts and NULL-safe equality are
 * NOT dialect members — the store core builds every statement through drizzle's
 * matching dialect (selected off `name`), which emits `$N`/`?` placeholders and
 * `"…"`/`` `…` `` identifiers per engine. These dialects only carry what drizzle
 * can't infer from a dynamic, column-per-field schema.
 */
import type { SqlDialect } from "@lunora/sql-store";
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

/**
 * The collation every MySQL character column this dialect declares is pinned to.
 *
 * MySQL 8's server default is `utf8mb4_0900_ai_ci` — **accent- and
 * case-insensitive**. SQLite compares TEXT byte for byte and Postgres compares
 * `text` for equality byte for byte, so an unqualified column inherited a third
 * set of semantics and `.global()` stopped meaning the same thing per engine:
 * `"Acme"` and `"acme"` folded into one row in an `__agg_` counter, `.unique()`
 * rejected `alice@` against `Alice@`, `ne "CAFE"` excluded `"café"`, and — the
 * one that makes this a security bug rather than a papercut — a `rankPage`
 * partitioned on a tenant key returned another tenant's rows.
 *
 * `utf8mb4_0900_bin`, not `utf8mb4_bin`: the former compares code points with NO
 * PAD, which is what SQLite and Postgres do. `utf8mb4_bin` is PAD SPACE, so
 * `'a' = 'a  '` would still be true on MySQL and false on the other two. It is
 * MySQL 8.0+ only, which is the floor Hyperdrive's MySQL support targets; an
 * older server rejects the DDL loudly rather than silently folding case.
 *
 * Declared per **column** rather than per table or per connection. A connection
 * collation loses to the column's own on every `column = 'literal'` comparison
 * (the column has the lower coercibility), so it would fix nothing; a table
 * default would need a new `SqlDialect` member for the DDL builder to render,
 * for an answer the column type already carries to every site that declares one
 * — the main tables, the rank companion's sort columns, and the companion keys.
 *
 * **Pre-existing tables keep the collation they were created with.**
 * `CREATE TABLE IF NOT EXISTS` does not reshape one, and neither does anything
 * here: converting is a full table rebuild, which is not something to run from a
 * cold start. A binding provisioned before this ships needs the operator to run
 * `ALTER TABLE <t> CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`
 * once per table, companions included.
 */
const MYSQL_COLLATION = "utf8mb4_0900_bin";

/** A character column's declaration with {@link MYSQL_COLLATION} pinned onto it. */
const collated = (type: string): string => `${type} COLLATE ${MYSQL_COLLATION}`;

/** MySQL storage type for a validator `kind`. Shared by `columnType` and the index-prefix decision below. */
const mysqlColumnType = (kind: string | undefined): string => {
    switch (kind) {
        case "bigint": {
            // stored as the order-preserving 40-character key `bigintSqlKey`
            // builds (sign + 39 digits) — never truncates.
            return collated("VARCHAR(64)");
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
            // Everything else — string/id/literal/geoPoint/union/any/from AND the
            // composites (object/array/record) — is unbounded text so a value never
            // truncates; `indexKeyPrefix` adds a key prefix wherever one is indexed.
            //
            // The composites are NOT a MySQL `JSON` column, which matches Postgres's
            // plain `TEXT` for them. `sqliteEncode` stores a composite holding a
            // bigint, bytes, `Date`, `Map`, `Set` or `NaN` in the wire-marked form
            // `$lunora.wire$[…]` — deliberately not valid JSON, so the reader can
            // tell it from ordinary JSON — and MySQL validates a `JSON` column on
            // insert, rejecting it outright with ER_3140. A `union`/`any`/`from`
            // column is stored by its runtime JS type for the same reason: a
            // `v.from(z.string())` column holds a bare `hello`.
            return collated("LONGTEXT");
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
                // string/id/literal, bigint (the order-preserving 40-character
                // key `bigintSqlKey` builds, same as the MySQL arm above),
                // object/array/record/union/any (JSON text).
                return "TEXT";
            }
        }
    },
    frameworkColumns: () => [
        { name: "id", type: "TEXT PRIMARY KEY" },
        { name: "_creationTime", type: "DOUBLE PRECISION NOT NULL" },
    ],
    isUniqueViolation: (error) => {
        const { code } = error as { code?: unknown };

        return code === "23505" || (error instanceof Error && PG_UNIQUE_VIOLATION_RE.test(error.message));
    },
    /** Postgres allows 1,600 columns per table (fewer once wide types are involved, which the engine reports on its own). */
    maxTableColumns: 1600,
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
        // Collated like every other character column: `__key__` carries the
        // aggregate/group key tuple and `__partition__` the rank partition, and
        // a case-folding comparison on either merges two distinct groups into one.
        key: collated("VARCHAR(768)"),
        real: "DOUBLE",
        // Unbounded post-image storage (CDC `doc`); never an index key, so no bound.
        text: collated("LONGTEXT"),
    },
    columnType: mysqlColumnType,
    frameworkColumns: () => [
        { name: "id", type: `${collated("VARCHAR(768)")} PRIMARY KEY` },
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
    /** MySQL's hard ceiling is 4,096 columns per table; InnoDB's practical limit is lower and row-size-bound, which the engine reports on its own. */
    maxTableColumns: 4096,
    name: "mysql",
    supportsFts5: false,
    supportsReturning: false,

    tableExists: (table) => sql`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ${table}`,
};
