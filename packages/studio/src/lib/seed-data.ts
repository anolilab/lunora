/**
 * Tiny client for the studio's local seed-data endpoint (the "Generate rows"
 * action). Like the schema-edit client, this is NOT a worker admin RPC: it
 * talks to the dev host (the `@cirrus/vite` middleware or the `cirrus dev`
 * studio server) over a same-origin `fetch`. The host runs `@cirrus/seed`'s
 * deterministic planner in Node and returns the generated rows; the caller then
 * inserts them through the worker's `writeRow` admin RPC.
 *
 * Running generation in Node keeps `@faker-js/faker` out of both the studio
 * browser bundle and the production worker — it lives only in the dev host
 * process. The endpoint is reachable only in local dev (the host 403s the route
 * on a non-loopback bind), so it carries no admin token.
 *
 * Both hosts mount the handler at the absolute path below — independent of the
 * studio's `basePath` — so the client targets it directly. Keep this in sync
 * with `SEED_ENDPOINT` in `@cirrus/config/studio-host`.
 */
import type { ColumnMeta } from "./admin";

/** Endpoint both dev hosts mount the seed-data handler at. */
const SEED_ENDPOINT = "/__cirrus/seed";

/**
 * The maximum number of rows the studio will request in a single call. Bounded
 * to keep inserts fast and the UI responsive; the operator can call again for
 * more. The host clamps independently as a safety net.
 */
const MAX_GENERATE_ROWS = 200;

/**
 * The maximum number of existing row ids sampled when a `v.id("table")` column
 * needs a real FK reference. Sampling more than this is unnecessary — the
 * planner only needs a pool to link against, not a full table scan.
 */
const MAX_FK_SAMPLE = 50;

/** Request payload sent to the seed-data endpoint. */
interface SeedRowsRequest {
    /** How many rows to generate (clamped to {@link MAX_GENERATE_ROWS}). */
    readonly count: number;
    /** Existing FK ids keyed by parent table name, so the planner links rather than fabricates parents. */
    readonly existingIds: Readonly<Record<string, ReadonlyArray<string>>>;
    /** Per-click hash seed — vary it so repeated clicks don't regenerate identical `_id`s. */
    readonly seed: number;
    /** The table to generate rows for. */
    readonly table: string;
}

/** Outcome of a seed-rows request, normalised to a discriminated union. */
type SeedRowsResult = { kind: "error"; message: string } | { kind: "ok"; rows: ReadonlyArray<Record<string, unknown>> };

/**
 * Collect the names of FK columns whose pool is empty so they can be surfaced
 * in the UI. The planner links FK columns only when the parent table has
 * sampled ids; an empty pool means that relation won't be populated.
 */
const collectSkippedFkColumns = (columns: ReadonlyArray<ColumnMeta>, fkPools: Readonly<Record<string, ReadonlyArray<string>>>): string[] => {
    const skipped: string[] = [];

    for (const column of columns) {
        if (column.pk !== true && column.ref !== undefined && column.type === "id" && (fkPools[column.ref] ?? []).length === 0) {
            skipped.push(column.name);
        }
    }

    return skipped;
};

/** Request generated rows from the dev host, normalising every outcome. */
const requestSeedRows = async (request: SeedRowsRequest): Promise<SeedRowsResult> => {
    const response = await fetch(SEED_ENDPOINT, {
        body: JSON.stringify(request),
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });
    const body = (await response.json()) as { error?: string; ok?: boolean; rows?: ReadonlyArray<Record<string, unknown>> };

    if (response.ok && body.rows !== undefined) {
        return { kind: "ok", rows: body.rows };
    }

    return { kind: "error", message: body.error ?? `seed request failed (${String(response.status)})` };
};

export type { SeedRowsRequest, SeedRowsResult };
export { collectSkippedFkColumns, MAX_FK_SAMPLE, MAX_GENERATE_ROWS, requestSeedRows, SEED_ENDPOINT };
