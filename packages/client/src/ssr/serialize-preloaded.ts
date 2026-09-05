import { decodeWire, encodeWire } from "../../../../shared/wire-codec";
import type { Preloaded } from "../types";

/**
 * Serialize a {@link Preloaded} token to a JSON string for embedding in the
 * rendered HTML (e.g. a `<script>` payload the client
 * reads on hydration).
 *
 * The payload is **wire-encoded** first, exactly as the RPC transport encodes
 * its own bodies ({@link file://../service.ts}). `preloadQuery` captures
 * `await client.query(...)`, whose RPC path ends at `decodeWire(body.result)` —
 * so a `v.bigint()` column arrives here as a real `bigint` (which
 * `JSON.stringify` **throws** on) and a `v.bytes()` column as a real
 * `ArrayBuffer` (which `JSON.stringify` silently degrades to an index-keyed
 * object). The query `args` are user-supplied and carry the same kinds.
 * `encodeWire` is identity for JSON-safe data, so a pure-JSON snapshot
 * serializes byte-for-byte as it did before.
 *
 * The `<` is escaped to `<` so the payload is safe to inline inside a
 * `<script>` tag without a stray `</script>` (or `<!--`) prematurely closing
 * it — the standard XSS-safe script-embedding precaution. This escaping is NOT
 * sufficient for an HTML *attribute* sink (which also needs the quote and `&`
 * characters escaped); embed the output in a raw-text script element, not a
 * data attribute.
 */
export const serializePreloaded = <T>(preloaded: Preloaded<T>): string => JSON.stringify(encodeWire(preloaded)).replaceAll("<", String.raw`\u003c`);

/**
 * Inverse of {@link serializePreloaded}: parse a serialized token back into a
 * {@link Preloaded} value on the client, running the parsed payload back
 * through {@link decodeWire} so `bigint` / `ArrayBuffer` / typed-array leaves
 * are restored rather than left in their tagged form. The `<` escape from
 * serialization is transparent to `JSON.parse`, so no un-escaping step is
 * needed.
 */
export const deserializePreloaded = <T = unknown>(serialized: string): Preloaded<T> => decodeWire(JSON.parse(serialized)) as Preloaded<T>;
