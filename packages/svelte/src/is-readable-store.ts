import type { Readable } from "svelte/store";

/**
 * Narrow a maybe-reactive value to a Svelte `Readable` store by its
 * `subscribe` function — how `subscribeReactiveArgs` tells a reactive args
 * source from a plain args record or the `"skip"` sentinel.
 */
// eslint-disable-next-line import/prefer-default-export -- named export so it composes with the other named imports at its call sites; a default would not.
export const isReadableStore = <T>(value: T | Readable<T>): value is Readable<T> =>
    typeof (value as { subscribe?: unknown } | null | undefined)?.subscribe === "function";
