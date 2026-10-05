/**
 * Shared primitives for reading Analytics Engine, used by every AE reader.
 *
 * Every reader speaks Cloudflare's **Analytics SQL** dialect through
 * `@lunora/bindings/analytics-sql` — `POST /client/v4/analytics/sql` with
 * `{ query, params, scope: { accountTag } }` — so every value a request
 * supplies is a bound `$name` parameter and never SQL text.
 * @see https://developers.cloudflare.com/analytics/sql-api/query-api/
 */
import type { AnalyticsSql } from "@lunora/bindings/analytics-sql";
import { createAnalyticsSql, createAnalyticsSqlRest } from "@lunora/bindings/analytics-sql";

/** The account credentials an AE reader queries with (+ an injectable `fetch` for tests). */
export interface AnalyticsSqlCredentials {
    accountId: string;
    /** API token with Account Analytics Read. */
    apiToken: string;
    fetch?: typeof globalThis.fetch;
}

/**
 * An Analytics SQL client over the REST endpoint, scoped to `accountId` by the
 * request's `scope.accountTag` — so no statement here carries a tenancy predicate,
 * which the SQL API rejects alongside a request-level scope.
 */
export const createRestAnalyticsSql = (credentials: AnalyticsSqlCredentials): AnalyticsSql =>
    createAnalyticsSql({
        binding: createAnalyticsSqlRest({
            accountId: credentials.accountId,
            apiToken: credentials.apiToken,
            ...(credentials.fetch === undefined ? {} : { fetch: credentials.fetch }),
        }),
    });

/**
 * The Analytics SQL table for an AE dataset: `events.analyticsEngine."DATASET"`.
 *
 * The dataset names the table, so it cannot be a bound parameter; it is quoted as
 * an identifier (an embedded `"` doubled), which also admits the hyphenated names
 * a bare identifier cannot. It comes from deployment config, never from a request.
 */
export const analyticsEngineTable = (dataset: string): string => `events.analyticsEngine."${dataset.replaceAll('"', '""')}"`;

/** The `.000Z` tail `toISOString` always writes. */
const MILLISECONDS_SUFFIX = /\.\d{3}Z$/u;

/**
 * Epoch seconds as the ISO-8601 UTC timestamp the dialect compares `timestamp`
 * against (`2026-09-15T08:30:00Z`). Second precision, matching AE's `DateTime`.
 */
export const isoSeconds = (epochSec: number): string => new Date(Math.floor(epochSec) * 1000).toISOString().replace(MILLISECONDS_SUFFIX, "Z");

/**
 * A time-bucket expression: `timestamp` rounded down to a `bucketSec` boundary,
 * as epoch **seconds** (what the folds read back). `bucketSec` is a positive
 * integer from our own config, never a request value, and the dialect's
 * `INTERVAL` takes a literal.
 */
export const bucketExpression = (bucketSec: number): string =>
    `toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '${String(Math.max(Math.floor(bucketSec), 1))}' SECOND))`;

/**
 * The separator for composite accumulator keys folded out of AE rows.
 *
 * A NUL escape rather than a printable character: the parts are user-supplied
 * metric names and function paths, so any printable separator can also appear
 * INSIDE a part and collide two distinct series into one. Space-joined, a metric
 * named `"checkout latency"` with an empty kind and one named `"checkout"` with
 * kind `"latency"` produce the same key and silently sum together.
 *
 * Written as the escape sequence, never as a literal control byte — a raw NUL in
 * a source file makes the whole file binary to `grep`, which silently voids every
 * text search that would otherwise have found it.
 */
export const KEY_SEPARATOR = "\u0000";
