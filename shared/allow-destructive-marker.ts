/**
 * The line comment that confirms a migration's destructive statement is intended, matched exactly. It counts only on
 * its own line before that statement; `lunora migrate generate` writes it there for each statement it confirms, so it
 * stays with that statement when a generated file is split into one `Migration` per statement.
 *
 * Shared rather than imported from `@lunora/d1` by `@lunora/cli`, because the two are released independently: a CLI
 * that read it from `@lunora/d1` at runtime could not load next to a published D1 that predates the export.
 */
export const ALLOW_DESTRUCTIVE_MARKER = "-- lunora:allow-destructive";
