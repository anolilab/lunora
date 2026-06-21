import type { FunctionReference } from "@lunora/client";

/**
 * Narrow an unknown value to a {@link FunctionReference} by its `__lunoraRef`
 * marker. Used by the overloaded adapters (`query`, `subscription`,
 * `paginatedQuery`/`infiniteQuery`) to tell an explicit-client-first call from a
 * function-reference-first call that resolves the ambient context client.
 */
// eslint-disable-next-line import/prefer-default-export -- named export so the overload-resolving adapters share one guard by name; a default would not compose with their other named imports.
export const isFunctionReference = (value: unknown): value is FunctionReference =>
    typeof value === "object" && value !== null && typeof (value as { __lunoraRef?: unknown }).__lunoraRef === "string";
