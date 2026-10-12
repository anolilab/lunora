import type { FunctionIR, HttpRouteIR, ModuleIR } from "./ir";
import { buildOpenApiDocument, emitOpenApiModule } from "./openapi";
import { buildOpenRpcDocument, emitOpenRpcModule } from "./openrpc";
import { readProjectVersion } from "./run-codegen-files";

/** What the machine-readable API specs are built from. */
export interface SpecArtifactsInput {
    functions: ReadonlyArray<FunctionIR>;
    httpRoutes: ReadonlyArray<HttpRouteIR>;
    /** Declared modules; only attached to the specs once the app opts into the architecture manifest. */
    modules: ReadonlyArray<ModuleIR>;
    projectRoot: string;
    wantsArchitecture: boolean;
}

/** The OpenAPI and OpenRPC artifacts, each as its portable `.json` and its worker-importable `.ts`. */
export interface SpecArtifacts {
    openApiContent: string;
    openApiModuleContent: string;
    openRpcContent: string;
    openRpcModuleContent: string;
}

/**
 * Build each spec document once, then derive both of its artifacts from the same
 * object, so the portable `.json` and the worker-importable `.ts` are identical and
 * can never drift. Both are built regardless of `apiSpec` (cheap and pure), so the
 * result can carry whichever the caller asked for. Only the requested files are written.
 */
export const buildSpecArtifacts = (input: SpecArtifactsInput): SpecArtifacts => {
    const projectVersion = readProjectVersion(input.projectRoot);
    // Module-tagged specs only once the app opts in, matching the manifest.
    const specModules = input.wantsArchitecture ? input.modules : [];
    const openApiDocument = buildOpenApiDocument({ functions: input.functions, httpRoutes: input.httpRoutes, modules: specModules, version: projectVersion });
    const openRpcDocument = buildOpenRpcDocument({ functions: input.functions, modules: specModules, version: projectVersion });

    return {
        openApiContent: `${JSON.stringify(openApiDocument, undefined, 2)}\n`,
        openApiModuleContent: emitOpenApiModule(openApiDocument),
        openRpcContent: `${JSON.stringify(openRpcDocument, undefined, 2)}\n`,
        openRpcModuleContent: emitOpenRpcModule(openRpcDocument),
    };
};
