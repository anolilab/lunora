/**
 * Sanitize a file path (relative to the lunora dir, no extension) into a
 * JS-identifier-safe namespace. Used in three places that MUST agree:
 * `emitApi` (the nested key path inside `ApiTypes`), `emitServer` (module-import
 * alias and dispatch-table key prefix), and the `anyApi` Proxy in
 * `@lunora/server` (emits `__lunoraRef = "${segments joined by _}:${fn}"`).
 *
 * If these ever disagree, runtime dispatch silently misses functions.
 */
/** A feature/component directory's trailing `index` segment (collapsed to the dir name). */
const INDEX_SUFFIX = /\/index$/u;
/** Any character that isn't valid in a JS identifier. */
const NON_IDENTIFIER = /[^\dA-Za-z]/gu;

/**
 * The `api.*` key path of a function file: `billing/invoices` → `["billing", "invoices"]`.
 *
 * `lunora/ratelimit/index.ts` surfaces as `api.ratelimit.*` (and dispatches as
 * `ratelimit:fn`) rather than the noisy `api.ratelimit.index.*` — the registry
 * convention. Only a trailing `/index` is dropped, so `lunora/index.ts` and
 * `lunora/ratelimit/queries.ts` (→ `api.ratelimit.queries`) are unaffected.
 */
const namespaceSegments = (filePath: string): string[] =>
    filePath
        .replace(INDEX_SUFFIX, "")
        .split("/")
        .map((segment) => segment.replaceAll(NON_IDENTIFIER, "_"));

/** The dispatch namespace: the key path joined by `_` (`billing/invoices` → `billing_invoices`), as the `anyApi` proxy joins it. */
const sanitizeNamespace = (filePath: string): string => namespaceSegments(filePath).join("_");

export { namespaceSegments, sanitizeNamespace };
