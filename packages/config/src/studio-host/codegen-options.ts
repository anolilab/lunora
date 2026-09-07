import type { CodegenOptions } from "@lunora/codegen";
import { CodegenDiagnosticError, runCodegen } from "@lunora/codegen";

import { collectWranglerSecretVariables } from "../cloudflare/wrangler-secret-variables";
import { CODEGEN_ENV, isCodegenDisabled } from "../codegen-env";

/** The request fields a studio endpoint carries that shape its codegen run. */
interface StudioCodegenRequest {
    /** API-spec mode the host runs codegen with (`@lunora/vite`'s `apiSpec` option). */
    readonly apiSpec?: CodegenOptions["apiSpec"];
    /** Project root containing the `lunora/` directory. */
    readonly projectRoot: string;
    /** Override the lunora subdirectory name. Defaults to `"lunora"`. */
    readonly schemaDirectory?: string;
}

/**
 * The `runCodegen` options a studio endpoint regenerates with — the SAME ones
 * the host's own codegen run uses.
 *
 * Both matter. `apiSpec` because codegen writes whichever spec file the mode
 * names and deletes the other: a studio edit that defaulted to `"openapi"`
 * deleted the `openrpc.json` an `apiSpec: "openrpc"` project had just
 * generated. `wranglerVariables` because the plaintext-secret lint reports
 * nothing when it is handed no evidence, so the edit would silently regenerate
 * with that security check disabled.
 *
 * `target` is deliberately absent: `runCodegen` resolves it from `lunora.json`
 * when omitted, which is the same value the host would pass.
 */
const studioCodegenOptions = (request: StudioCodegenRequest): CodegenOptions => {
    return {
        apiSpec: request.apiSpec,
        lunoraDirectory: request.schemaDirectory ?? "lunora",
        projectRoot: request.projectRoot,
        wranglerVariables: collectWranglerSecretVariables(request.projectRoot),
    };
};

/**
 * Regenerate after a studio endpoint wrote the project's source, honouring the
 * codegen switch. Returns the diagnostics to surface in the response body.
 *
 * The gate is here, not in each endpoint, because every studio endpoint that
 * writes source regenerates through this one function — and the two that existed
 * both called `runCodegen` unconditionally, so `lunora dev --no-codegen` printed
 * that `_generated/` is written only by an explicit `lunora codegen` and then one
 * studio "add column" rewrote the whole tree. `--no-codegen` and
 * {@link CODEGEN_ENV} are one switch with two spellings (the flag travels as the
 * variable so it reaches processes that never see argv), so reading the variable
 * is reading the flag.
 *
 * Codegen diagnostics surface in the response rather than failing the write: the
 * file is already on disk. Any other error is the caller's to turn into a `500`.
 */
const runStudioCodegen = (request: StudioCodegenRequest): ReadonlyArray<string> => {
    if (isCodegenDisabled(process.env[CODEGEN_ENV])) {
        return [`codegen is off (${CODEGEN_ENV}=0 / \`lunora dev --no-codegen\`) — the source was written but \`_generated/\` was NOT regenerated`];
    }

    try {
        runCodegen(studioCodegenOptions(request));
    } catch (error: unknown) {
        if (error instanceof CodegenDiagnosticError) {
            return [error.message];
        }

        throw error;
    }

    return [];
};

export type { StudioCodegenRequest };
export { runStudioCodegen, studioCodegenOptions };
