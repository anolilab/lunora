import type { AdvisorTable } from "../../schema";

/**
 * Shared foreign-key index helpers for the two complementary FK-coverage lints —
 * `unindexed_foreign_key` (audits a table's own `one`-side FK) and
 * `unindexed_relation_target` (audits the `many`-side FK on the target table).
 * Keeping these in one place stops the two lints from drifting on what "indexed"
 * means (e.g. which index kinds qualify, leftmost-prefix coverage).
 */

/** The implicit primary-key column; it is always indexed, so an FK onto it needs no extra index. */
export const PRIMARY_KEY = "_id";

/** Convert an FK column into a conventional index name, e.g. `authorId` → `byAuthorId`. */
export const suggestIndexName = (field: string): string => `by${field.charAt(0).toUpperCase()}${field.slice(1)}`;

/**
 * Columns that lead a btree (`kind: "index"`) secondary index — the only index
 * kind that serves an FK equality lookup. A search (FTS) or vector (ANN) index
 * does not, and a rank index's btree is keyed on its sort columns, not arbitrary
 * leading columns. Coverage follows SQLite's leftmost-prefix rule, so only the
 * first field of each index counts.
 */
export const leadingIndexedColumns = (table: AdvisorTable): Set<string> =>
    new Set(
        table.indexes
            .filter((index) => index.kind === "index")
            .map((index) => index.fields[0])
            .filter((field): field is string => field !== undefined),
    );
