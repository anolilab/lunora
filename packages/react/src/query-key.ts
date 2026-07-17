import type { FunctionReference } from "@lunora/client";
import type { QueryKey } from "@tanstack/react-query";

import { stableWireKey } from "../../../shared/wire-key";

/**
 * Pure, transport-free query-key helpers shared by the client hooks
 * (`./cache.js`) and the server entry (`./server.js`). The only runtime import
 * is `stableWireKey` — a pure, dependency-free string encoder the bundler
 * inlines — so importing this module server-side still never pulls in the
 * browser-oriented subscription registry or a `LunoraClient` instance.
 */

/**
 * Stringified queryKey used as a stable index/dep-list key. Encoded with
 * `stableWireKey` (not raw `JSON.stringify`) so the `args` object nested in
 * the key hashes identically regardless of property insertion order — matching
 * how TanStack itself hashes query keys — and so a wire-typed arg (`bigint`,
 * `Date`, bytes, …) hashes to a distinct stable token instead of throwing.
 * Byte-identical to the previous `stableStringify` hash for pure-JSON keys.
 */
const keyHash = (queryKey: QueryKey): string => stableWireKey(queryKey);

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

export { keyHash, lunoraQueryKey, serializeQueryKey };

export { stableStringify } from "../../../shared/stable-key";
export { stableWireKey } from "../../../shared/wire-key";
