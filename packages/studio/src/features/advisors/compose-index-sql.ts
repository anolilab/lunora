/**
 * Compose a `CREATE INDEX IF NOT EXISTS` statement from an advisory finding's
 * metadata. Used by the "apply index" action in the Performance Advisor to
 * surface a ready-to-run DDL statement from a missing-index finding without
 * running it ad-hoc — the statement is shown to the operator for review before
 * any action is taken.
 */

import { sqlIdentifier } from "../../lib/internal";

/** Metadata shape of an `unindexed_foreign_key` finding that carries enough info to compose DDL. */
interface IndexFindingMetadata {
    /** The suggested index: name + covering fields (single-column for FK lints). */
    readonly suggestedIndex: {
        readonly fields: ReadonlyArray<string>;
        readonly name: string;
    };
    /** The table that is missing the index. */
    readonly table: string;
}

/**
 * Return true when a finding's metadata carries the `table` and `suggestedIndex`
 * fields needed to compose a `CREATE INDEX` statement. Used to gate whether the
 * apply action renders on a given finding.
 */
const hasIndexMetadata = (metadata: Record<string, unknown>): metadata is IndexFindingMetadata & Record<string, unknown> => {
    const { suggestedIndex, table } = metadata as Record<string, unknown> & { suggestedIndex?: unknown; table?: unknown };

    if (typeof table !== "string" || table.length === 0) {
        return false;
    }

    if (typeof suggestedIndex !== "object" || suggestedIndex === null) {
        return false;
    }

    const { fields, name } = suggestedIndex as Record<string, unknown>;

    // Every MEMBER, not just the array: `[null]` / `[42]` satisfied
    // `Array.isArray` and the predicate then exposed them as strings, so the
    // advisory action handed one to `sqlIdentifier`, which calls `.replaceAll`
    // on it — a TypeError thrown while rendering rather than a hidden action.
    if (!Array.isArray(fields) || fields.length === 0 || !fields.every((field) => typeof field === "string" && field.length > 0)) {
        return false;
    }

    // `name` was asserted by the type predicate but never checked. `metadata` is
    // server-supplied `Record<string, unknown>`, so a finding carrying a
    // non-string name reached `quoteIdentifier`, which calls `.replaceAll` on it
    // — a TypeError thrown inside the render rather than a hidden action.
    return typeof name === "string" && name.length > 0;
};

/**
 * Compose a `CREATE INDEX IF NOT EXISTS` statement from `table`, `indexName`,
 * and `fields`. The statement uses `IF NOT EXISTS` so it is safely idempotent —
 * running it twice on a shard that already has the index is a no-op.
 *
 * Column names are quoted with double-quotes to handle reserved words and
 * mixed-case identifiers correctly (SQLite accepts both `"column"` and
 * `[column]` quoting; double-quotes is the SQL standard).
 */
const composeCreateIndex = (table: string, indexName: string, fields: ReadonlyArray<string>): string => {
    const quotedTable = sqlIdentifier(table);
    const quotedIndex = sqlIdentifier(indexName);
    const quotedColumns = fields.map((f) => sqlIdentifier(f)).join(", ");

    return `CREATE INDEX IF NOT EXISTS ${quotedIndex} ON ${quotedTable} (${quotedColumns});`;
};

export type { IndexFindingMetadata };
export { composeCreateIndex, hasIndexMetadata };
