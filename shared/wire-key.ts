/**
 * Wire-faithful stable-key encoder — the composition of {@link file://./wire-codec.ts}'s
 * `encodeWire` and {@link file://./stable-key.ts}'s `stableStringify`, shared
 * (bundler-inlined, like both of its parts) by the client SDK (`@lunora/client`),
 * the framework adapters (`@lunora/react`, `@lunora/vue`, `@lunora/solid`), and
 * the Durable Object runtime (`@lunora/do`). See
 * `plans/090-subscription-arg-wire-fidelity.md`.
 *
 * ## Why
 *
 * An arg that doubles as a reactive **cache key** (subscription / `useQuery` /
 * shape args) must encode to a stable string. Raw `stableStringify` fails loud on
 * every value plain JSON can't carry (`bigint`, `Date`, `Map`, `Set`, `URL`,
 * bytes) — but those values DO round-trip the RPC/WS wire via `encodeWire`'s
 * tagged form. Keying on the **encoded** tree closes that gap:
 *
 * - `encodeWire` is **identity for pure JSON**, so every existing pure-JSON key
 *   is byte-identical to `stableStringify(args)` — no cache invalidation, and the
 *   client / DO key namespaces stay aligned across versions.
 * - A wire-supported leaf becomes its deterministic tagged token
 *   (`["$lunora.wire$","bigint","123"]`, …), so two subscriptions whose args
 *   differ only by a `bigint` / `Date` / bytes value get **distinct** keys
 *   instead of throwing (or, worse, colliding).
 * - A value the wire itself refuses (`RegExp`, `Headers`, a class instance, a
 *   cyclic graph) still **fails loud** with a `TypeError` via `encodeWire`'s
 *   prototype guard — such a value can never be a stable key.
 *
 * ## Caveats (deliberate)
 *
 * - `Map` / `Set` keys preserve **insertion order** (as the wire does), so two
 *   structurally-equal Maps built in different orders key differently — they open
 *   separate subscriptions rather than corrupting each other's data. Maps as
 *   query args are pathological; prefer plain objects.
 * - `undefined` in an **array position** keys as its tagged form (distinct from
 *   `null`), unlike `stableStringify`'s JSON-style `null` coercion — strictly
 *   more faithful, and only reachable for non-JSON-clean args.
 * - `NaN` / `±Infinity` key as distinct tagged tokens instead of all collapsing
 *   to `null`.
 */

import { stableStringify } from "./stable-key";
import { encodeWire } from "./wire-codec";

/**
 * Stable cache/dedup key for a (possibly wire-typed) `value`: the sorted-key
 * stable encoding of its wire form. Byte-identical to `stableStringify(value)`
 * for pure-JSON values; deterministic tagged tokens for `bigint`/`Date`/`Map`/
 * `Set`/`URL`/bytes; throws a `TypeError` on values the wire refuses.
 */
const stableWireKey = (value: unknown): string => stableStringify(encodeWire(value));

export { stableWireKey };
