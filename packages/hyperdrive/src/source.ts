/**
 * Read-side helpers for the external-source ingest bridge (plan 077).
 *
 * The bridge is two steps, split across Lunora's action/mutation boundary: an
 * **action** reads the tenant slice from Hyperdrive via `ctx.sql` (action-only,
 * non-deterministic), projects each external row to a Lunora document, and hands
 * the documents to a **mutation** that materializes them into the DO's SQLite
 * (`materializeExternalRows` from `@lunora/shard-engine`) — after which `defineShape` carries
 * the slice to clients unchanged.
 *
 * This module owns the read+project half. `pullSourceRows` runs the parameterised
 * tenant query and maps every row; `projectSourceRow` is the per-row mapping (the
 * external primary key becomes `_id`, plus an optional `map` transform). The write
 * half (diff + apply) lives in `@lunora/shard-engine`. The declarative `.source()` table
 * modifier (Phase 2) automates this whole loop on a poll alarm; this is the manual,
 * blessed pattern that unblocks the use case today.
 */

import { liftSourceId } from "@lunora/shard-engine";

import type { SqlClient } from "./types";

/** How an external row maps to a Lunora document. */
interface ProjectOptions {
    /**
     * Column whose value becomes the Lunora `_id` (stringified). Defaults to `"id"`.
     * With no `map`, this column is dropped from the document body (it lives on as
     * `_id`); with a `map`, the mapper owns the body and `_id` is added from here.
     */
    idColumn?: string;

    /**
     * Transform an external row into the stored document body. Omit for the default:
     * every selected column except `idColumn` is copied verbatim. The returned object
     * must not include `_id` — it is set from `idColumn`.
     */
    map?: (row: Record<string, unknown>) => Record<string, unknown>;
}

/** Options for {@link pullSourceRows}: the parameterised tenant query plus the row projection. */
interface PullSourceOptions extends ProjectOptions {
    /** Bound parameter values, positionally matched to `query` (the tenant scope binds here). */
    params?: ReadonlyArray<unknown>;
    /** The full tenant-membership query with driver-native placeholders (`$1` / `?`). */
    query: string;
}

/**
 * Project one external row to a Lunora document: lift `idColumn` to a stringified
 * `_id`, then either apply `map` or copy every other column verbatim. Throws when
 * the id column is missing/nullish so a misconfigured query fails loudly rather than
 * materializing rows under an `"undefined"` id.
 *
 * Delegates to `@lunora/shard-engine`'s `liftSourceId` — the single id-lift the declarative
 * `.source()` poll loop also uses — so the manual bridge and the codegen path can
 * never diverge in their missing-id handling.
 */
const projectSourceRow = (row: Record<string, unknown>, options: ProjectOptions = {}): Record<string, unknown> => liftSourceId(row, options);

/**
 * Run a parameterised tenant query against Hyperdrive and project every row to a
 * Lunora document ready to hand to `materializeExternalRows`. Call this inside an
 * **action** (where `ctx.sql` lives); pass the result to a mutation for the write.
 */
const pullSourceRows = async (sql: SqlClient, options: PullSourceOptions): Promise<Record<string, unknown>[]> => {
    const { idColumn, map, params, query } = options;
    const rows = await sql.query(query, params);

    return rows.map((row) => projectSourceRow(row, { idColumn, map }));
};

export { projectSourceRow, pullSourceRows };
export type { ProjectOptions, PullSourceOptions };
