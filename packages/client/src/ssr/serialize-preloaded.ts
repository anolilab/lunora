import type { Preloaded } from "../types";

/**
 * Serialize a {@link Preloaded} token to a JSON string for embedding in the
 * rendered HTML (e.g. a `&lt;script>` payload the client
 * reads on hydration). Every field of `Preloaded` is JSON-serializable by
 * construction — `preloadQuery` only captures the query args, function path,
 * optional shard key, and the resolved value — so this is a thin, explicit
 * `JSON.stringify` that documents the dehydration seam and keeps callers from
 * accidentally stringifying a non-serializable wrapper.
 *
 * The `&lt;` is escaped to `&lt;` so the payload is safe to inline inside a
 * `&lt;script>` tag without a stray `&lt;/script>` (or `&lt;!--`) prematurely closing
 * it — the standard XSS-safe script-embedding precaution. This escaping is NOT
 * sufficient for an HTML *attribute* sink (which also needs the quote and `&amp;`
 * characters escaped); embed the output in a raw-text script element, not a
 * data attribute.
 */
export const serializePreloaded = <T>(preloaded: Preloaded<T>): string => JSON.stringify(preloaded).replaceAll("<", String.raw`\u003c`);

/**
 * Inverse of {@link serializePreloaded}: parse a serialized token back into a
 * {@link Preloaded} value on the client. The `&lt;` escape from serialization
 * is transparent to `JSON.parse`, so no un-escaping step is needed.
 */
export const deserializePreloaded = <T = unknown>(serialized: string): Preloaded<T> => JSON.parse(serialized) as Preloaded<T>;
