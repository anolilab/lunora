/**
 * Local seed-data request handler for the studio's "Generate rows" action. A
 * sibling of {@link ./schema-edit-handler} / {@link ./policy-scaffold-handler}:
 * transport-agnostic so both dev hosts — the `@lunora/vite` `/__lunora`
 * middleware and the `lunora dev` studio server — can mount it, each adapting
 * its own request/response object.
 *
 * Why a Node endpoint rather than generating in the browser: `@lunora/seed`'s
 * generator is built on `@faker-js/faker`, a heavy dependency. Running it here
 * keeps faker out of both the studio's browser bundle **and** the deployed
 * worker — the schema is lifted statically from `lunora/schema.ts` (the project
 * filesystem + toolchain), so this is local-dev-only by construction and never
 * reachable from a deployed worker. The dev hosts mount it on a loopback bind.
 *
 * The handler is pure over its inputs apart from reading the schema file: it
 * generates rows and returns them, but never inserts. The studio client routes
 * the returned rows through the existing schema-aware `writeRow` admin RPC —
 * the same path the add-row form uses — so all the write-side authz is unchanged.
 */
import { existsSync } from "node:fs";

import { discoverSchema, schemaFromIr } from "@lunora/codegen";
import { seedPlan } from "@lunora/seed";
import { Project } from "ts-morph";

import join from "../path";

/**
 * Endpoint path both dev hosts mount the handler at. A sibling of the schema
 * editor's `/__lunora/schema-edit`; the double underscore keeps it clear of the
 * CLI's `/_lunora/*` worker proxy (single underscore).
 */
const SEED_ENDPOINT = "/__lunora/seed";

/**
 * Hard upper bound on rows generated per request — a safety net independent of
 * the studio's own UX cap, so a hand-crafted request can't ask for a runaway
 * generation that blocks the dev host.
 */
const MAX_SEED_ROWS = 1000;

/** Body the host transport adapts from a `POST` — one generate-rows request. */
interface SeedRequestBody {
    /** How many rows to generate (clamped to `[1, MAX_SEED_ROWS]`). */
    readonly count?: number;

    /**
     * Ids of rows that already exist in the live DB, keyed by referenced table.
     * Foreign keys resolve against these, and every referenced parent table
     * present here is treated as covered — so the generator links to existing
     * rows instead of fabricating new parent rows. The studio samples these from
     * the target table's FK columns before calling.
     */
    readonly existingIds?: Readonly<Record<string, ReadonlyArray<string>>>;
    /** Deterministic mapping selector — same value yields identical rows. */
    readonly seed?: number;
    /** The table to generate rows for. */
    readonly table?: string;
}

/** A request adapted from the host transport. */
interface SeedRequest {
    /** Parsed JSON body of the `POST`. */
    readonly body?: unknown;
    /** HTTP method — only `POST` is handled. */
    readonly method: string;
    /** Project root containing the `lunora/` directory. */
    readonly projectRoot: string;
    /** Override the lunora subdirectory name. Defaults to `"lunora"`. */
    readonly schemaDirectory?: string;
}

/** A response the host transport serialises back as JSON with `status`. */
interface SeedResponse {
    readonly body: unknown;
    readonly status: number;
}

/**
 * Make a generated row JSON-safe: a `v.bigint` cell becomes a number (the
 * generator's range is small and safe) and a `v.bytes` `ArrayBuffer` becomes a
 * byte array. Mirrors the `lunora seed` CLI's NDJSON serialization so both
 * adapters hand the writer the same wire shape. Every other generated value is
 * already JSON-native.
 */
const jsonReplacer = (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") {
        return Number(value);
    }

    if (value instanceof ArrayBuffer) {
        return [...new Uint8Array(value)];
    }

    return value;
};

/** Clamp a requested count to a positive integer within the safety bound. */
const clampCount = (count: number | undefined): number => {
    if (typeof count !== "number" || !Number.isFinite(count)) {
        return 10;
    }

    return Math.min(Math.max(1, Math.floor(count)), MAX_SEED_ROWS);
};

/**
 * Handle a generate-rows request: statically lift the schema, generate `count`
 * rows for `table` (linking foreign keys to the supplied existing ids rather
 * than fabricating parents), and return them JSON-safe for the client to insert.
 *
 * Only the requested table's rows are ever returned, so a foreign key with no
 * `existingIds` to resolve against is answered with `409
 * fk-parents-empty` naming the parent tables — the endpoint refuses
 * rather than hand back children whose parents it just dropped.
 */
const handleSeedRequest = (request: SeedRequest): SeedResponse => {
    if (request.method !== "POST") {
        return { body: { error: "method-not-allowed", ok: false }, status: 405 };
    }

    const { body } = request;

    if (body === undefined || body === null || typeof body !== "object") {
        return { body: { error: "invalid-request", ok: false }, status: 400 };
    }

    const { count, existingIds, seed, table } = body as SeedRequestBody;

    if (typeof table !== "string" || table.length === 0) {
        return { body: { error: "missing-table", ok: false }, status: 400 };
    }

    const lunoraDirectory = request.schemaDirectory ?? "lunora";
    const schemaPath = join(request.projectRoot, lunoraDirectory, "schema.ts");

    if (!existsSync(schemaPath)) {
        return { body: { error: "schema-not-found", ok: false }, status: 404 };
    }

    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const ir = discoverSchema(project, schemaPath);

    if (!ir.tables.some((candidate) => candidate.name === table)) {
        return { body: { error: "unknown-table", ok: false, table }, status: 404 };
    }

    const schema = schemaFromIr(ir);
    const plan = seedPlan(schema, {
        // Pass every sampled parent table as `existingIds` so the generator links
        // to live rows and never fabricates parents — matching the studio's
        // "existing rows are not affected, FKs point at what's there" semantics.
        existingIds: existingIds ?? {},
        defaultCount: clampCount(count),
        only: [table],
        seed: seed ?? 0,
    });

    // `existingIds` covers a parent only when it supplies at least one id; where it
    // does not, `seedPlan` FABRICATES that parent's rows and points the children at
    // them. Those extra table plans are dropped one line down, so the returned
    // children would carry `_id`s of parents that never reach `writeRow` — dangling
    // foreign keys the caller inserts. Refuse instead, which is what this endpoint's
    // own doc comment claims and what only the studio client enforced.
    //
    // `fk-parents-empty` is the code the studio client (and its tests) already
    // decode into "no rows to reference in X — seed those tables first"; nothing
    // ever emitted it, so that branch had never run against a real reply.
    const fabricated = plan.filter((entry) => entry.table !== table).map((entry) => entry.table);

    if (fabricated.length > 0) {
        return { body: { error: "fk-parents-empty", ok: false, tables: fabricated }, status: 409 };
    }

    const rows = plan.find((entry) => entry.table === table)?.rows ?? [];
    // Round-trip through the replacer so bigint/ArrayBuffer cells survive the
    // host's own `JSON.stringify` of the response body.
    const jsonSafeRows = JSON.parse(JSON.stringify(rows, jsonReplacer)) as ReadonlyArray<Record<string, unknown>>;

    return { body: { ok: true, rows: jsonSafeRows }, status: 200 };
};

export type { SeedRequest, SeedRequestBody, SeedResponse };
export { handleSeedRequest, SEED_ENDPOINT };
