import type { AdvisorTable } from "../schema";

/**
 * Framework-managed columns every table has implicitly. They never appear in a
 * table's declared `fields`, so a column-resolution check must treat them as
 * always valid (an index or relation may legitimately reference `_id`).
 */
export const SYSTEM_FIELDS: ReadonlySet<string> = new Set(["_creationTime", "_id"]);

/**
 * Build a `Set` of a table's columns (declared + system) once, so repeated
 * membership checks inside a hot loop are O(1) instead of an O(n)
 * `Array.includes` scan.
 */
export const tableColumnSet = (table: AdvisorTable): ReadonlySet<string> => new Set<string>([...SYSTEM_FIELDS, ...table.fields]);
