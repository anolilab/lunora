/**
 * Tiny client for the studio's local seed-data endpoint (the "Generate rows"
 * action). Like the schema-edit client, this is NOT a worker admin RPC: it
 * talks to the dev host (the `@lunora/vite` middleware or the `lunora dev`
 * studio server) over a same-origin `fetch`. The host runs `@lunora/seed`'s
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
 * with `SEED_ENDPOINT` in `@lunora/config/studio-host`.
 */
import { decodeWire, isPlainObject } from "../../../../shared/wire-codec";
import type { ColumnMeta } from "./admin";
import { errorMessage } from "./internal";

/** Endpoint both dev hosts mount the seed-data handler at. */
const SEED_ENDPOINT = "/__lunora/seed";

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
 * Collect the names of FK columns whose parent table has no rows to link
 * against, so the UI can say which relations block generation.
 *
 * Generation cannot proceed for these: the planner has no id to point the
 * column at, and the endpoint refuses rather than fabricate a parent it would
 * then drop. The parent has to be seeded first.
 */
const collectUnresolvableFkColumns = (columns: ReadonlyArray<ColumnMeta>, fkPools: Readonly<Record<string, ReadonlyArray<string>>>): string[] => {
    const blocked: string[] = [];

    for (const column of columns) {
        if (column.pk !== true && column.ref !== undefined && column.type === "id" && (fkPools[column.ref] ?? []).length === 0) {
            blocked.push(column.name);
        }
    }

    return blocked;
};

/** The reply envelope, typed as it actually arrives: every field is host-supplied and unvalidated. */
interface SeedResponseBody {
    readonly error?: unknown;
    readonly rows?: unknown;
    readonly tables?: unknown;
}

/**
 * Narrow a decoded reply to the row documents `onInsertRows` can hand to
 * `importShard`.
 *
 * `isPlainObject` rather than `typeof === "object"`: this runs AFTER
 * `decodeWire`, which turns tagged leaves into `Date`, `Map`, `Set` and
 * `Uint8Array` — every one of which is `typeof "object"` and none of which is a
 * row document. A `!Array.isArray` check is enough for bare `JSON.parse` output
 * and not for this one.
 */
const isRowList = (value: unknown): value is ReadonlyArray<Record<string, unknown>> => Array.isArray(value) && value.every((row) => isPlainObject(row));

/**
 * Request generated rows from the dev host, normalising every outcome.
 *
 * The rows come back `encodeWire`d, so they are `decodeWire`d here: that is what
 * turns a `v.bigint()` cell back into a real `bigint` and a `v.bytes()` cell back
 * into an `ArrayBuffer` before the caller hands them to `importShard`, whose
 * per-column validators reject the JSON-narrowed forms. Identity for pure JSON.
 *
 * EVERY failure comes back as `{ kind: "error" }` rather than a rejection. The
 * only caller (`GenerateRowsDialog`) runs this inside a `try`/`finally` with no
 * `catch` and dispatches it through `fireAndForget`, which swallows a rejection
 * — so a throw here left the dialog silently doing nothing at all. Four paths
 * could throw: the transport itself (dev host down, route unmounted), a body
 * that is not JSON (an HTML 404 page), `decodeWire` on a malformed tag, and
 * `.join` on a non-array `tables`. A body of literal `null` parses fine and then
 * threw on the first property read.
 */
const requestSeedRows = async (request: SeedRowsRequest): Promise<SeedRowsResult> => {
    let response: Response;

    try {
        response = await fetch(SEED_ENDPOINT, {
            body: JSON.stringify(request),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
    } catch (error) {
        return { kind: "error", message: `seed request failed: ${errorMessage(error)}` };
    }

    let body: SeedResponseBody;

    try {
        body = ((await response.json()) as SeedResponseBody | null) ?? {};
    } catch {
        return { kind: "error", message: `seed request failed (${String(response.status)})` };
    }

    if (response.ok && body.rows !== undefined) {
        let decoded: unknown;

        try {
            decoded = decodeWire(body.rows);
        } catch (error) {
            return { kind: "error", message: `seed response could not be decoded: ${errorMessage(error)}` };
        }

        if (!isRowList(decoded)) {
            return { kind: "error", message: "seed response did not carry a list of row documents" };
        }

        return { kind: "ok", rows: decoded };
    }

    if (body.error === "fk-parents-empty") {
        const tables = Array.isArray(body.tables) ? body.tables.filter((table): table is string => typeof table === "string") : [];

        return { kind: "error", message: `no rows to reference in ${tables.join(", ")} — seed those tables first` };
    }

    return { kind: "error", message: typeof body.error === "string" ? body.error : `seed request failed (${String(response.status)})` };
};

export type { SeedRowsRequest, SeedRowsResult };
export { collectUnresolvableFkColumns, MAX_FK_SAMPLE, MAX_GENERATE_ROWS, requestSeedRows, SEED_ENDPOINT };
