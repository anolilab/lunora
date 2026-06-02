import type { FunctionReference } from "@cirrus/client";
import type { QueryKey } from "@tanstack/react-query";

/**
 * Pure, transport-free query-key helpers shared by the client hooks
 * (`./cache.js`) and the server entry (`./server.js`). Kept in their own module
 * — with only type-level imports — so importing them server-side never pulls in
 * the browser-oriented subscription registry or a `CirrusClient` instance.
 */

/** Stringified queryKey used as a stable index/dep-list key. */
const keyHash = (queryKey: QueryKey): string => JSON.stringify(queryKey);

/**
 * Project a Cirrus `(fn, args, shardKey)` triple into the structural query key
 * TanStack hashes for dedup. The `"cirrus"` literal namespaces our entries so
 * an app's own queries can't collide with ours.
 *
 * This is the single source of truth for the key shape: `useQuery`,
 * `usePreloadedQuery`, and the server-side `prefetchQuery` all route through it
 * so a value prefetched on the server lands under the exact key the client hook
 * reads back — no loading flash, no duplicate fetch.
 */
const cirrusQueryKey = (function_: FunctionReference, args: Record<string, unknown>, shardKey: string | undefined): QueryKey => [
    "cirrus",
    function_.__cirrusRef,
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

export { cirrusQueryKey, keyHash, serializeQueryKey };
