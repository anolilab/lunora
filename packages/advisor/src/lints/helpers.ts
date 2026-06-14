import type { AdvisorTable } from "../schema";

/**
 * Framework-managed columns every table has implicitly. They never appear in a
 * table's declared `fields`, so a column-resolution check must treat them as
 * always valid (an index or relation may legitimately reference `_id`).
 */
export const SYSTEM_FIELDS: ReadonlySet<string> = new Set(["_creationTime", "_id"]);

/** True when `column` is a declared or system column of `table`. */
export const hasColumn = (table: AdvisorTable, column: string): boolean => SYSTEM_FIELDS.has(column) || table.fields.includes(column);

/**
 * Build a `Set` of a table's columns (declared + system) once, so repeated
 * membership checks inside a hot loop are O(1) instead of `hasColumn`'s O(n)
 * `Array.includes` scan. Behavior is identical to calling `hasColumn` per field.
 */
export const tableColumnSet = (table: AdvisorTable): ReadonlySet<string> => new Set<string>([...SYSTEM_FIELDS, ...table.fields]);
