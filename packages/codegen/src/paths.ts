/*
 * How a function file's path (relative to `lunora/`, no extension) becomes its
 * `api.*` key path (`namespaceSegments`) and its dispatch namespace
 * (`sanitizeNamespace`, the segments joined by `_`). The emitted `api.ts` /
 * `internal.ts` / `functions.ts` and codegen's `functionKeyOf` must all agree;
 * if they ever disagree, runtime dispatch silently misses functions.
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

/** The dispatch namespace: the key path joined by `_` (`billing/invoices` → `billing_invoices`). */
const sanitizeNamespace = (filePath: string): string => namespaceSegments(filePath).join("_");

export { namespaceSegments, sanitizeNamespace };
