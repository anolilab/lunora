/**
 * Local policy-scaffold request handler for the access-rule editor (plan 025
 * Item 3). The RLS sibling of {@link ./schema-edit-handler}: transport-agnostic
 * so both dev hosts — the `@cirrus/vite` `/__cirrus` middleware and the
 * `cirrus dev` studio server — can mount it, each adapting its own
 * request/response object to {@link PolicyScaffoldRequest} / the returned
 * {@link PolicyScaffoldResponse}.
 *
 * Local-dev-only by construction: it writes a new policy stub under `cirrus/`
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
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import { CodegenDiagnosticError, runCodegen } from "@cirrus/codegen";

import join from "../path";
import type { DestructivePolicyEdit, PolicyEdit, PolicyScaffoldFailureReason, ScaffoldPolicyEdit, WireRlsEdit } from "../schema-edit/policy-scaffold";
import { classifyPolicyEdit, scaffoldPolicyFile, wireRlsIntoProcedure } from "../schema-edit/policy-scaffold";

/**
 * Endpoint path both dev hosts mount the handler at. A sibling of the schema
 * editor's `/__cirrus/schema-edit`; the double underscore keeps it clear of the
 * CLI's `/_cirrus/*` worker proxy (single underscore).
 */
const POLICY_SCAFFOLD_ENDPOINT = "/__cirrus/policy-scaffold";

/** A `wireRls` request additionally carries the procedure's source-file path. */
interface WirePolicyEdit extends WireRlsEdit {
    /** Cirrus-relative module path of the procedure file (no extension), e.g. `messages/list`. */
    readonly filePath: string;
}

/** Body the host transport adapts from a `POST` — one scaffolder request. */
type PolicyScaffoldBody = DestructivePolicyEdit | ScaffoldPolicyEdit | WirePolicyEdit;

/** A request adapted from the host transport. */
interface PolicyScaffoldRequest {
    /** Parsed JSON body of the `POST`. */
    readonly body?: unknown;
    /** HTTP method — only `POST` is handled. */
    readonly method: string;
    /** Project root containing the `cirrus/` directory. */
    readonly projectRoot: string;
    /** Override the cirrus subdirectory name. Defaults to `"cirrus"`. */
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

/** Write source atomically (temp file + rename) so a crash can't leave a half-written file. */
const writeAtomic = (path: string, text: string): void => {
    const temporaryPath = `${path}.cirrus-tmp`;

    writeFileSync(temporaryPath, text, "utf8");
    renameSync(temporaryPath, path);
};

/**
 * Re-run codegen after an applied edit so the generated types + RLS matrix
 * follow the new source. Codegen diagnostics surface in the response body
 * rather than failing the write (the file is already on disk); any other error
 * is a hard `500`.
 */
const runCodegenForResponse = (request: PolicyScaffoldRequest, okBody: Record<string, unknown>): PolicyScaffoldResponse => {
    let diagnostics: ReadonlyArray<string> = [];

    try {
        runCodegen({ cirrusDirectory: request.schemaDirectory ?? "cirrus", projectRoot: request.projectRoot });
    } catch (error: unknown) {
        if (error instanceof CodegenDiagnosticError) {
            diagnostics = [error.message];
        } else {
            return { body: { error: error instanceof Error ? error.message : String(error), ok: false }, status: 500 };
        }
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
    const result = scaffoldPolicyFile(edit);

    if (!result.ok) {
        return { body: { error: result.reason, ok: false }, status: statusForFailure(result.reason) };
    }

    const cirrusDirectory = request.schemaDirectory ?? "cirrus";
    const targetPath = join(request.projectRoot, cirrusDirectory, result.fileName);

    // Never clobber an existing policy file — that could erase a developer's
    // real rules. Refuse and let the editor surface the conflict.
    if (existsSync(targetPath)) {
        return { body: { error: "file-exists", fileName: result.fileName, ok: false }, status: 409 };
    }

    writeAtomic(targetPath, result.source);

    return runCodegenForResponse(request, { fileName: result.fileName });
};

/**
 * Resolve a procedure file path inside the cirrus directory, rejecting absolute
 * paths and `..` traversal so a request can't reach outside the project tree.
 */
const resolveProcedureFile = (projectRoot: string, cirrusDirectory: string, filePath: string): string | undefined => {
    if (typeof filePath !== "string" || filePath.length === 0 || isAbsolute(filePath) || filePath.includes("\\")) {
        return undefined;
    }

    const cirrusRoot = join(projectRoot, cirrusDirectory);
    const resolved = join(cirrusRoot, `${filePath}.ts`);
    const relativePath = relative(cirrusRoot, resolved);

    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        return undefined;
    }

    return resolved;
};

/** Handle a `wireRls` request: append `.use(rls(policies))` to an existing procedure's chain. */
const handleWireRls = (request: PolicyScaffoldRequest, edit: WirePolicyEdit): PolicyScaffoldResponse => {
    const procedurePath = resolveProcedureFile(request.projectRoot, request.schemaDirectory ?? "cirrus", edit.filePath);

    if (procedurePath === undefined || !existsSync(procedurePath)) {
        return { body: { error: "unknown-procedure", ok: false }, status: 404 };
    }

    const wired = wireRlsIntoProcedure(readFileSync(procedurePath, "utf8"), edit);

    if (!wired.ok) {
        return { body: { error: wired.reason, ok: false }, status: statusForFailure(wired.reason) };
    }

    writeAtomic(procedurePath, wired.text);

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

    if (body === undefined || typeof body !== "object" || typeof (body as { kind?: unknown }).kind !== "string") {
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

    // Unreachable: the only remaining kind is destructive, handled above.
    return refuseDestructive(edit);
};

export type { PolicyScaffoldBody, PolicyScaffoldRequest, PolicyScaffoldResponse, WirePolicyEdit };
export { handlePolicyScaffoldRequest, POLICY_SCAFFOLD_ENDPOINT };
