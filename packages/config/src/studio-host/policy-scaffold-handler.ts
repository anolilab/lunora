/**
 * Local policy-scaffold request handler for the access-rule editor (plan 025
 * Item 3). The RLS sibling of {@link ./schema-edit-handler}: transport-agnostic
 * so both dev hosts — the `@lunora/vite` `/__lunora` middleware and the
 * `lunora dev` studio server — can mount it, each adapting its own
 * request/response object to {@link PolicyScaffoldRequest} / the returned
 * {@link PolicyScaffoldResponse}.
 *
 * Local-dev-only by construction: it writes a new policy stub under `lunora/`
 * (or appends `.use(rls(...))` to a procedure file) and runs codegen, both of
 * which need the project's filesystem + toolchain, so it is never reachable from
 * a deployed worker. The dev hosts mount it only on a loopback bind, gated by
 * the same `schemaEditable` capability as the schema editor.
 *
 * Only **additive** scaffolding applies: a `scaffoldPolicy` writes a new
 * `name.policies.ts` deny-by-default stub (refusing to overwrite an existing
 * file), and a `wireRls` appends `.use(rls(policies))` to an existing builder
 * chain. A destructive request (rewriting an existing `when`) answers `409` and
 * writes nothing — it routes to the manual-edit/migration path.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import type { CodegenOptions } from "@lunora/codegen";
import { LunoraError } from "@lunora/errors";

import join from "../path";
import type { DestructivePolicyEdit, PolicyEdit, PolicyScaffoldFailureReason, ScaffoldPolicyEdit, WireRlsEdit } from "../schema-edit/policy-scaffold";
import { classifyPolicyEdit, resolveServerModule, scaffoldPolicyFile, wireRlsIntoProcedure } from "../schema-edit/policy-scaffold";
import { runStudioCodegen } from "./codegen-options";
import writeFileAtomic from "./write-atomic";

/**
 * Endpoint path both dev hosts mount the handler at. A sibling of the schema
 * editor's `/__lunora/schema-edit`; the double underscore keeps it clear of the
 * CLI's `/_lunora/*` worker proxy (single underscore).
 */
const POLICY_SCAFFOLD_ENDPOINT = "/__lunora/policy-scaffold";

/** A `wireRls` request additionally carries the procedure's source-file path. */
interface WirePolicyEdit extends WireRlsEdit {
    /** Lunora-relative module path of the procedure file (no extension), e.g. `messages/list`. */
    readonly filePath: string;
}

/** Body the host transport adapts from a `POST` — one scaffolder request. */
type PolicyScaffoldBody = DestructivePolicyEdit | ScaffoldPolicyEdit | WirePolicyEdit;

/** A request adapted from the host transport. */
interface PolicyScaffoldRequest {
    /** API-spec mode the host runs codegen with; forwarded to the regeneration. */
    readonly apiSpec?: CodegenOptions["apiSpec"];
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
interface PolicyScaffoldResponse {
    readonly body: unknown;
    readonly status: number;
}

/** Map a scaffolder failure reason to an HTTP status. */
const statusForFailure = (reason: PolicyScaffoldFailureReason): number => {
    if (reason === "unknown-procedure") {
        return 404;
    }

    if (reason === "already-wired") {
        return 409;
    }

    // invalid-identifier / unsupported-procedure-shape / destructive: the
    // request shape is the problem, not server state.
    return reason === "destructive" ? 409 : 422;
};

/**
 * Re-run codegen after an applied edit so the generated types + RLS matrix
 * follow the new source. Codegen diagnostics surface in the response body
 * rather than failing the write (the file is already on disk); any other error
 * is a hard `500`.
 */
const runCodegenForResponse = (request: PolicyScaffoldRequest, okBody: Record<string, unknown>): PolicyScaffoldResponse => {
    let diagnostics: ReadonlyArray<string>;

    try {
        diagnostics = runStudioCodegen(request);
    } catch (error: unknown) {
        return { body: { error: error instanceof Error ? error.message : String(error), ok: false }, status: 500 };
    }

    return { body: { ...okBody, diagnostics, ok: true }, status: 200 };
};

/** A destructive request never writes; it hands off to the manual-edit/migration path. */
const refuseDestructive = (edit: PolicyEdit): PolicyScaffoldResponse => {
    return {
        body: {
            edit,
            message:
                "Rewriting an existing policy predicate changes evaluation semantics and must be done by hand. The scaffolder only adds new, deny-by-default rules.",
            needsManualEdit: true,
            ok: false,
        },
        status: 409,
    };
};

/** Handle a `scaffoldPolicy` request: write a new stub file, refusing to overwrite. */
const handleScaffoldPolicy = (request: PolicyScaffoldRequest, edit: ScaffoldPolicyEdit): PolicyScaffoldResponse => {
    const result = scaffoldPolicyFile(edit, resolveServerModule(request.projectRoot));

    if (!result.ok) {
        return { body: { error: result.reason, ok: false }, status: statusForFailure(result.reason) };
    }

    const lunoraDirectory = request.schemaDirectory ?? "lunora";
    const targetPath = join(request.projectRoot, lunoraDirectory, result.fileName);

    // Never clobber an existing policy file — that could erase a developer's
    // real rules. Refuse and let the editor surface the conflict.
    if (existsSync(targetPath)) {
        return { body: { error: "file-exists", fileName: result.fileName, ok: false }, status: 409 };
    }

    writeFileAtomic(targetPath, result.source);

    return runCodegenForResponse(request, { fileName: result.fileName });
};

/**
 * Resolve a procedure file path inside the lunora directory, rejecting absolute
 * paths and `..` traversal so a request can't reach outside the project tree.
 */
const resolveProcedureFile = (projectRoot: string, lunoraDirectory: string, filePath: string): string | undefined => {
    if (typeof filePath !== "string" || filePath.length === 0 || isAbsolute(filePath) || filePath.includes("\\")) {
        return undefined;
    }

    const lunoraRoot = join(projectRoot, lunoraDirectory);
    const resolved = join(lunoraRoot, `${filePath}.ts`);
    const relativePath = relative(lunoraRoot, resolved);

    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        return undefined;
    }

    return resolved;
};

/** Handle a `wireRls` request: append `.use(rls(policies))` to an existing procedure's chain. */
const handleWireRls = (request: PolicyScaffoldRequest, edit: WirePolicyEdit): PolicyScaffoldResponse => {
    const procedurePath = resolveProcedureFile(request.projectRoot, request.schemaDirectory ?? "lunora", edit.filePath);

    if (procedurePath === undefined || !existsSync(procedurePath)) {
        return { body: { error: "unknown-procedure", ok: false }, status: 404 };
    }

    const wired = wireRlsIntoProcedure(readFileSync(procedurePath, "utf8"), edit, resolveServerModule(request.projectRoot));

    if (!wired.ok) {
        return { body: { error: wired.reason, ok: false }, status: statusForFailure(wired.reason) };
    }

    writeFileAtomic(procedurePath, wired.text);

    return runCodegenForResponse(request, { exportName: edit.exportName });
};

/**
 * Handle a policy-scaffold request. Pure over its inputs apart from the file
 * I/O + codegen it performs on an applied edit; safe to unit-test against a
 * temp project directory.
 */
const handlePolicyScaffoldRequest = (request: PolicyScaffoldRequest): PolicyScaffoldResponse => {
    if (request.method !== "POST") {
        return { body: { error: "method-not-allowed", ok: false }, status: 405 };
    }

    const { body } = request;

    if (body === undefined || body === null || typeof body !== "object" || typeof (body as { kind?: unknown }).kind !== "string") {
        return { body: { error: "invalid-edit", ok: false }, status: 400 };
    }

    const edit = body as PolicyScaffoldBody;

    // Destructive requests never touch source — route to the manual-edit path.
    if (classifyPolicyEdit(edit) === "destructive") {
        return refuseDestructive(edit);
    }

    if (edit.kind === "scaffoldPolicy") {
        return handleScaffoldPolicy(request, edit);
    }

    if (edit.kind === "wireRls") {
        return handleWireRls(request, edit);
    }

    // Unreachable: `classifyPolicyEdit` routed every non-additive kind to the
    // destructive branch above, leaving only the two additive kinds handled
    // here. Throw rather than guess so a future additive kind that forgets its
    // branch fails loudly instead of silently masquerading as destructive.
    throw new LunoraError("INTERNAL", `unhandled additive policy edit kind: ${String((edit as { kind?: unknown }).kind)}`);
};

export type { PolicyScaffoldBody, PolicyScaffoldRequest, PolicyScaffoldResponse, WirePolicyEdit };
export { handlePolicyScaffoldRequest, POLICY_SCAFFOLD_ENDPOINT };
