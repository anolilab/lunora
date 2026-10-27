import { stableWireKey } from "@lunora/wire";
import type { QueryKey } from "@tanstack/react-query";

/**
 * Pure, transport-free query-key helpers shared by the client hooks
 * (`./cache.js`) and the server entry (`./server.js`). The runtime imports are
 * `stableWireKey` and the key builders from `@lunora/client/query`, both pure,
 * so importing this module server-side still never pulls in the
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
 * Stringify a queryKey for use in a React effect's dep list. TanStack hashes
 * queryKeys structurally, so the dep list mirrors that — two args objects with
 * the same contents but different identity hash to the same string and won't
 * trigger a re-attach.
 */
const serializeQueryKey = (queryKey: QueryKey): string => keyHash(queryKey);

export { keyHash, serializeQueryKey };

// The key shape is the framework-neutral contract in `@lunora/client/query`;
// re-exported so the hooks and the server entry keep one import site.
export { lunoraQueryKey, lunoraQueryKeyFromArgsKey } from "@lunora/client/query";
export { stableStringify } from "@lunora/wire";
export { stableWireKey } from "@lunora/wire";
