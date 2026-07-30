/**
 * Single source of truth for "does this wrangler config enable Workers
 * Cache?" and "what compatibility_date does that require?".
 *
 * Before this module, `reconcile-compatibility-date.ts` (auto-bump) and
 * `wrangler-validator.ts` (validation) each carried their own
 * `WORKERS_CACHE_MIN_DATE` literal and their own top-level/`exports[]`
 * cache-enabled walk — two copies of the same fact that could silently drift
 * apart (a date bumped in one file without the other would either validate a
 * config the reconciler wouldn't produce, or vice versa).
 */

/** The `compatibility_date` Workers Cache (`cache.enabled: true`) requires. */
export const WORKERS_CACHE_MIN_DATE = "2026-05-01";

/** The subset of a parsed `wrangler.jsonc` the cache-enabled check reads. */
export interface WranglerCacheShape {
    cache?: { enabled?: boolean } | null;
    exports?: Record<string, { cache?: { enabled?: boolean } | null } | null> | null;
}

/**
 * Whether Workers Cache is enabled anywhere in a parsed wrangler config — the
 * top-level `cache.enabled` toggle, or a per-export override in
 * `exports[name].cache.enabled` (Workers can scope cache per named export).
 * `undefined`/`null` (an unparsed or absent config) is treated as disabled.
 */
export const isCacheEnabled = (parsed: WranglerCacheShape | null | undefined): boolean => {
    if (!parsed) {
        return false;
    }

    const topLevel = typeof parsed.cache === "object" && parsed.cache !== null && parsed.cache.enabled === true;
    const inExports =
        typeof parsed.exports === "object" &&
        parsed.exports !== null &&
        Object.values(parsed.exports).some((entry) => typeof entry === "object" && entry !== null && entry.cache?.enabled === true);

    return topLevel || inExports;
};
