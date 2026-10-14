/**
 * Wire constants for the durable log archive, shared between the server route
 * (`@lunora/runtime`'s `log-archive-admin-routes`) and the Studio Archive feed
 * (`@lunora/studio`). Kept here — not in `@lunora/runtime` — because the studio
 * is a browser bundle that must not import a runtime *value* (which would drag
 * the DO/R2-SQL runtime into the browser). This file is dependency-free and
 * bundler-inlined into each consumer, so both sides share one source of truth
 * with no dependency edge.
 */

/**
 * The error `code` the archive route returns (400) when the operator has wired
 * no archive table (`logArchive`) or the `R2_SQL_*` credentials are missing. The
 * Studio keys its "not configured" empty state off this exact value.
 */
export const LOG_ARCHIVE_NOT_CONFIGURED = "LOG_ARCHIVE_NOT_CONFIGURED";
