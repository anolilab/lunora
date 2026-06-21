import type { FunctionReference } from "@lunora/client";
import type { QueryKey } from "@tanstack/react-query";

/**
 * Pure, transport-free query-key helpers shared by the client hooks
 * (`./cache.js`) and the server entry (`./server.js`). Kept in their own module
 * — with only type-level imports — so importing them server-side never pulls in
 * the browser-oriented subscription registry or a `LunoraClient` instance.
 */

/** Stringified queryKey used as a stable index/dep-list key. */
const keyHash = (queryKey: QueryKey): string => JSON.stringify(queryKey);

/**
 * `JSON.stringify` with deterministic key ordering for plain objects. Keeps a
 * subscription/stream cache key stable across rerenders where the consumer
 * happens to construct `args` with a different key order (`{a,b}` vs `{b,a}`).
 *
 * Shared by `useSubscription` and `useStream` so a key-order edge case fixed in
 * one never silently drifts from the other.
 */
const stableStringify = (value: unknown): string => {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b));

    return `{${entries.map(([key, value_]) => `${JSON.stringify(key)}:${stableStringify(value_)}`).join(",")}}`;
};

/**
 * Project a Lunora `(fn, args, shardKey)` triple into the structural query key
 * TanStack hashes for dedup. The `"lunora"` literal namespaces our entries so
 * an app's own queries can't collide with ours.
 *
 * This is the single source of truth for the key shape: `useQuery`,
 * `usePreloadedQuery`, and the server-side `prefetchQuery` all route through it
 * so a value prefetched on the server lands under the exact key the client hook
 * reads back — no loading flash, no duplicate fetch.
 */
const lunoraQueryKey = (function_: FunctionReference, args: Record<string, unknown>, shardKey: string | undefined): QueryKey => [
    "lunora",
    function_.__lunoraRef,
    args,
    // eslint-disable-next-line unicorn/no-null -- this literal is part of the JSON-serialized query key TanStack hashes for dedup; `null` keeps a stable, distinct slot from an absent shardKey across renders.
    shardKey ?? null,
];

/**
 * Stringify a queryKey for use in a React effect's dep list. TanStack hashes
 * queryKeys structurally, so the dep list mirrors that — two args objects with
 * the same contents but different identity hash to the same string and won't
 * trigger a re-attach.
 */
const serializeQueryKey = (queryKey: QueryKey): string => keyHash(queryKey);

export { keyHash, lunoraQueryKey, serializeQueryKey, stableStringify };
