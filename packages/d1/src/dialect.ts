/**
 * The Lunora **D1 dialect** — the single source of truth for how `.global()`
 * tables are physically shaped in D1.
 *
 * Both the runtime (`runD1GlobalTableMigrations` in `d1-ctx-db.ts`, which
 * auto-provisions tables) and the `lunora migrate generate` SQL emitter
 * (`@lunora/cli`'s `migration-diff.ts`) derive their DDL from these helpers, so
 * the table a migration writes is byte-identical to the one the runtime creates.
 * Previously each encoded the dialect independently and a comment begged them to
 * stay "in lockstep"; this module makes the lockstep structural.
 *
 * Exposed as the `@lunora/d1/dialect` subpath. Pure — no runtime dependencies —
 * so the CLI can import it without pulling the D1 runtime.
 */

// The one canonical SQL identifier quoter, bundler-inlined from `shared/` (zero
// runtime dep, keeps this module pure) and re-exported to preserve the
// `@lunora/d1/dialect` public API.
import { quoteIdentifier } from "../../../shared/quote-identifier";

/** SQLite column type affinities Lunora emits. */
export type SqlAffinity = "BLOB" | "INTEGER" | "REAL" | "TEXT";

/**
 * SQLite affinity for a column by its validator `kind`, chosen so the value the
 * D1 layer serializes round-trips intact:
 * - `boolean` → INTEGER (stored as 1/0)
 * - `number`/`timestamp`/`date` → REAL (numeric, never coerced to text)
 * - `bytes` → BLOB
 * - everything else → TEXT — string/id/literal, `bigint` (serialized as a
 * decimal string), and object/array/record/union/any (JSON). A numeric affinity
 * would coerce a numeric-looking string and corrupt the decode.
 */
export const sqlAffinityForKind = (kind: string | undefined): SqlAffinity => {
    switch (kind) {
        case "boolean": {
            return "INTEGER";
        }
        case "bytes": {
            return "BLOB";
        }
        case "date":
        case "number":
        case "timestamp": {
            return "REAL";
        }
        default: {
            return "TEXT";
        }
    }
};

/**
 * Most columns one D1 table may carry, framework columns included.
 *
 * D1 runs Workerd's SQLite build, which sets `SQLITE_LIMIT_COLUMN` to 100 where
 * stock SQLite allows 2,000. Exported so the two producers of global-table DDL
 * — the runtime auto-provisioner in `@lunora/sql-store` and the
 * `lunora migrate generate` emitter — check the same number rather than each
 * carrying its own copy.
 */
export const MAX_D1_TABLE_COLUMNS = 100;

/** Framework columns every global table carries: the physical `id` (exposed as `_id`) and `_creationTime`. */
export const frameworkColumnDdl = (): ReadonlyArray<string> => [
    `${quoteIdentifier("id")} TEXT PRIMARY KEY`,
    `${quoteIdentifier("_creationTime")} REAL NOT NULL`,
];

/**
 * Resolve a schema field to its physical D1 column: `_id`/`id` both map to the
 * physical `id` column, `_creationTime` to its own, every other field to itself.
 */
export const columnRef = (field: string): string => {
    if (field === "_id" || field === "id") {
        return quoteIdentifier("id");
    }

    if (field === "_creationTime") {
        return quoteIdentifier("_creationTime");
    }

    return quoteIdentifier(field);
};

/** Physical index identifier — `<table>_<name>`, so two tables' like-named indexes don't collide in SQLite's flat index namespace. */
export const physicalIndexName = (tableName: string, indexName: string): string => quoteIdentifier(`${tableName}_${indexName}`);

export { OCC_VERSION_COLUMN } from "../../../shared/occ-version-column";
export { quoteIdentifier } from "../../../shared/quote-identifier";
