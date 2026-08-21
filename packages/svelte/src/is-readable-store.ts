import type { Readable } from "svelte/store";

/**
 * Narrow an unknown value to a Svelte {@link Readable} store by its
 * `subscribe` function. Used by the query primitives (`query`,
 * `subscription`, `paginatedQuery`) to tell a reactive args source from a
 * plain args record or the `"skip"` sentinel.
 */
// eslint-disable-next-line import/prefer-default-export -- named export so the query primitives share one guard by name; a default would not compose with their other named imports.
export const isReadableStore = (value: unknown): value is Readable<unknown> =>
    typeof value === "object" && value !== null && typeof (value as { subscribe?: unknown }).subscribe === "function";
