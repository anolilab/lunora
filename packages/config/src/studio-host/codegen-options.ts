import type { CodegenOptions } from "@lunora/codegen";

import { collectWranglerSecretVariables } from "../cloudflare/wrangler-secret-variables";

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

export type { StudioCodegenRequest };
export { studioCodegenOptions };
