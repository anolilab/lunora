/**
 * Sanitize a file path (relative to the lunora dir, no extension) into a
 * JS-identifier-safe namespace. Used in three places that MUST agree:
 * `emitApi` (namespace key inside `ApiTypes`), `emitServer` (module-import
 * alias and dispatch-table key prefix), and the `anyApi` Proxy in
 * `@lunora/server` (emits `__lunoraRef = "${ns}:${fn}"`).
 *
 * If these ever disagree, runtime dispatch silently misses functions.
 */
/** A feature/component directory's trailing `index` segment (collapsed to the dir name). */
const INDEX_SUFFIX = /\/index$/u;
/** Any character that isn't valid in a JS identifier. */
const NON_IDENTIFIER = /[^\dA-Za-z]/gu;

const sanitizeNamespace = (filePath: string): string =>
    // `lunora/ratelimit/index.ts` surfaces as `api.ratelimit.*` (and dispatches as
    // `ratelimit:fn`) rather than the noisy `api.ratelimit_index.*` — the registry
    // convention. Only a trailing `/index` is dropped, so `lunora/index.ts` and
    // `lunora/ratelimit/queries.ts` (→ `ratelimit_queries`) are unaffected.
    filePath.replace(INDEX_SUFFIX, "").replaceAll(NON_IDENTIFIER, "_");

export default sanitizeNamespace;
