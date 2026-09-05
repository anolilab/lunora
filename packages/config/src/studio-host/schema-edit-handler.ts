/**
 * Local schema-edit request handler for the visual schema editor (plan 024
 * Item 3). Transport-agnostic so both dev hosts — the `@lunora/vite` `/__lunora`
 * middleware and the `lunora dev` studio server — can mount it; each adapts its
 * own request/response object to {@link SchemaEditRequest} / the returned
 * {@link SchemaEditResponse}.
 *
 * Local-dev-only by construction: it reads + writes `lunora/schema.ts` and runs
 * codegen, both of which need the project's filesystem and toolchain, so it is
 * never reachable from a deployed worker (which has no source tree). The dev
 * hosts mount it only on a loopback bind.
 *
 * `GET` parses `lunora/schema.ts` and returns the structured schema. A `POST`
 * additive edit applies via ts-morph, writes atomically, runs codegen, and
 * returns the new schema plus codegen diagnostics. A `POST` destructive edit
 * answers `409` with `{ needsMigration: true, ... }` and writes nothing; the
 * editor routes these to the migration handoff (Item 5).
 */
import { existsSync, readFileSync } from "node:fs";

import type { CodegenOptions } from "@lunora/codegen";

import join from "../path";
import type { ApplyFailureReason, SchemaEdit } from "../schema-edit/mutate";
import { applyAdditiveEdit, classifyEdit } from "../schema-edit/mutate";
import type { ParseSchemaResult, SchemaTable } from "../schema-edit/parse";
import { parseSchema } from "../schema-edit/parse";
import { runStudioCodegen } from "./codegen-options";
import writeFileAtomic from "./write-atomic";

/**
 * Endpoint path both dev hosts mount the handler at. Distinct from the CLI's
 * `/_lunora/*` worker proxy (single underscore), so a schema edit is never
 * forwarded to the worker.
 */
const SCHEMA_EDIT_ENDPOINT = "/__lunora/schema-edit";

/** A request adapted from the host transport. */
interface SchemaEditRequest {
    /** API-spec mode the host runs codegen with; forwarded to the regeneration. */
    readonly apiSpec?: CodegenOptions["apiSpec"];
    /** Parsed JSON body for a `POST`; ignored for `GET`. */
    readonly body?: unknown;
    /** HTTP method (`GET` / `POST`). */
    readonly method: string;
    /** Project root containing the `lunora/` directory. */
    readonly projectRoot: string;
    /** Override the lunora subdirectory name. Defaults to `"lunora"`. */
    readonly schemaDirectory?: string;
}

/** A response the host transport serialises back as JSON with `status`. */
interface SchemaEditResponse {
    readonly body: unknown;
    readonly status: number;
}

/** Map an apply-failure reason to an HTTP status. */
const statusForFailure = (reason: ApplyFailureReason): number => {
    if (reason === "destructive") {
        return 409;
    }

    if (reason === "duplicate-table" || reason === "duplicate-column" || reason === "duplicate-index") {
        return 409;
    }

    if (reason === "unknown-table") {
        return 404;
    }

    // invalid-identifier / invalid-validator: the request itself is malformed
    // (a non-identifier name, or validator text outside the `v.*` allow-list).
    if (reason === "invalid-identifier" || reason === "invalid-validator") {
        return 400;
    }

    // aliased-define-schema / no-define-schema / non-object-argument: the source
    // shape is unsupported, not the request itself.
    return 422;
};

/**
 * Map a parse failure to a response. Every parse failure (aliased / missing /
 * non-object `defineSchema`) is an unsupported source shape, not a bad request,
 * so they all answer `422`.
 */
const parseFailureResponse = (result: Extract<ParseSchemaResult, { ok: false }>): SchemaEditResponse => {
    return {
        body: { error: result.reason, ok: false },
        status: 422,
    };
};

/** Read + parse the schema, returning either the tables or a failure response. */
const readSchema = (schemaPath: string): { response: SchemaEditResponse } | { tables: ReadonlyArray<SchemaTable> } => {
    if (!existsSync(schemaPath)) {
        return { response: { body: { error: "no-schema-file", ok: false }, status: 404 } };
    }

    const parsed = parseSchema(readFileSync(schemaPath, "utf8"));

    if (!parsed.ok) {
        return { response: parseFailureResponse(parsed) };
    }

    return { tables: parsed.tables };
};

/** A destructive edit never writes; it hands off to the migrations workflow. */
const needsMigrationResponse = (edit: SchemaEdit): SchemaEditResponse => {
    return {
        body: {
            edit,
            message: "This edit changes stored data and must go through a migration. Review the migration before applying.",
            needsMigration: true,
            ok: false,
        },
        status: 409,
    };
};

/** Handle a `POST` additive/destructive edit. */
const handlePost = (request: SchemaEditRequest, schemaPath: string): SchemaEditResponse => {
    const edit = request.body as SchemaEdit | null | undefined;

    if (edit === undefined || edit === null || typeof edit !== "object" || typeof (edit as { kind?: unknown }).kind !== "string") {
        return { body: { error: "invalid-edit", ok: false }, status: 400 };
    }

    // Destructive edits never touch the source — route to the migration handoff.
    if (classifyEdit(edit) === "destructive") {
        return needsMigrationResponse(edit);
    }

    if (!existsSync(schemaPath)) {
        return { body: { error: "no-schema-file", ok: false }, status: 404 };
    }

    const applied = applyAdditiveEdit(readFileSync(schemaPath, "utf8"), edit);

    if (!applied.ok) {
        return { body: { error: applied.reason, ok: false }, status: statusForFailure(applied.reason) };
    }

    writeFileAtomic(schemaPath, applied.text);

    // Re-run codegen so the generated types + DO shape follow the new source —
    // unless the codegen switch is off, which `runStudioCodegen` owns.
    let diagnostics: ReadonlyArray<string>;

    try {
        diagnostics = runStudioCodegen(request);
    } catch (error: unknown) {
        return { body: { error: error instanceof Error ? error.message : String(error), ok: false }, status: 500 };
    }

    const parsed = parseSchema(applied.text);

    return {
        body: { diagnostics, ok: true, tables: parsed.ok ? parsed.tables : [] },
        status: 200,
    };
};

/**
 * Handle a schema-edit request. Pure over its inputs apart from the file I/O +
 * codegen it performs on a `POST` additive edit; safe to unit-test against a
 * temp project directory.
 */
const handleSchemaEditRequest = (request: SchemaEditRequest): SchemaEditResponse => {
    const schemaPath = join(request.projectRoot, request.schemaDirectory ?? "lunora", "schema.ts");

    if (request.method === "GET") {
        const read = readSchema(schemaPath);

        return "response" in read ? read.response : { body: { ok: true, tables: read.tables }, status: 200 };
    }

    if (request.method === "POST") {
        return handlePost(request, schemaPath);
    }

    return { body: { error: "method-not-allowed", ok: false }, status: 405 };
};

export type { SchemaEditRequest, SchemaEditResponse };
export { handleSchemaEditRequest, SCHEMA_EDIT_ENDPOINT };
