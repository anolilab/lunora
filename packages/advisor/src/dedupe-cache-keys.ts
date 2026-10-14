import type { Finding } from "./types";

/**
 * Disambiguate {@link Finding}s that share a `cacheKey`.
 *
 * A `cacheKey` is the studio's dedup / dismissal id (see {@link Finding.cacheKey}):
 * two findings with the same key collapse to one row, and a single dismissal
 * silences both. A lint keyed on `name:file:line` (the argument-derived sinks,
 * `sql_injection_risk`, `kv_unscoped_user_key_idor`, `hardcoded_secret`, …) can
 * legitimately emit two occurrences on one physical source line, so without a
 * within-line discriminator the second finding is silently hidden.
 *
 * This suffixes the second-and-later occurrence of any repeated key with
 * `:<n>` (`:2`, `:3`, …), leaving the first occurrence unsuffixed so existing
 * single-occurrence keys stay stable across runs. Order is preserved. Keys are
 * lint-name-prefixed, so this never merges across lints.
 */
// eslint-disable-next-line import/prefer-default-export -- named export by repo convention (no default exports)
export const dedupeCacheKeys = (findings: ReadonlyArray<Finding>): Finding[] => {
    const seen = new Map<string, number>();

    return findings.map((finding) => {
        const occurrence = (seen.get(finding.cacheKey) ?? 0) + 1;

        seen.set(finding.cacheKey, occurrence);

        if (occurrence === 1) {
            return finding;
        }

        return { ...finding, cacheKey: `${finding.cacheKey}:${occurrence.toString()}` };
    });
};
