import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { CodegenOptions } from "@lunora/codegen";
import { CodegenDiagnosticError, createCodegenProject, findTsconfig, projectConfigCandidatePaths, refreshCodegenProject, runCodegen } from "@lunora/codegen";

import { wranglerCodegenInputs } from "../cloudflare/wrangler-codegen-inputs";
import { CODEGEN_ENV, isCodegenDisabled } from "../codegen-env";

/** The request fields a studio endpoint carries that shape its codegen run. */
interface StudioCodegenRequest {
    /** API-spec mode the host runs codegen with (`@lunora/vite`'s `apiSpec` option). */
    readonly apiSpec?: CodegenOptions["apiSpec"];
    /** Lazy function mode the host runs codegen with. */
    readonly lazyFunctions?: CodegenOptions["lazyFunctions"];
    /** Project root containing the `lunora/` directory. */
    readonly projectRoot: string;
    /** Override the lunora subdirectory name. Defaults to `"lunora"`. */
    readonly schemaDirectory?: string;
}

/**
 * The `runCodegen` options a studio endpoint regenerates with — the SAME ones
 * the host's own codegen run uses.
 *
 * These travel together. `apiSpec` because codegen writes whichever spec file the mode
 * names and deletes the other: a studio edit that defaulted to `"openapi"`
 * deleted the `openrpc.json` an `apiSpec: "openrpc"` project had just
 * generated. The wrangler inputs because the plaintext-secret lint reports
 * nothing when it is handed no evidence, and the queue registry loses every
 * per-environment queue name without the producers. `lazyFunctions` because a
 * studio edit that regenerated eagerly would undo the host's lazy registry.
 *
 * `target` is deliberately absent: `runCodegen` resolves it from `lunora.config.*`
 * when omitted, which is the same value the host would pass.
 */
const studioCodegenOptions = (request: StudioCodegenRequest): CodegenOptions => {
    return {
        apiSpec: request.apiSpec,
        lazyFunctions: request.lazyFunctions,
        lunoraDirectory: request.schemaDirectory ?? "lunora",
        projectRoot: request.projectRoot,
        ...wranglerCodegenInputs(request.projectRoot),
    };
};

type CodegenProject = NonNullable<CodegenOptions["project"]>;

/**
 * The one Project studio edits regenerate with, kept across requests so an edit pays a
 * refresh instead of a cold ts-morph program build. `key` names what a refresh cannot
 * pick up (the tsconfig, `lunora.config.*`), which the dev-loop watchers invalidate on.
 */
let cachedProject: { key: string; lunoraDirectory: string; project: CodegenProject } | undefined;

const statKey = (path: string): string => {
    const stats = statSync(path);

    return `${path}:${String(stats.mtimeMs)}:${String(stats.size)}`;
};

/**
 * The inputs a refresh cannot pick up, by path, mtime and size.
 *
 * ponytail: stats the nearest `tsconfig.json` and the config candidates only, as the Vite
 * watcher does; an edit to an `extends`-ed tsconfig alone keeps the cached Project.
 */
const projectKey = (lunoraDirectory: string): string => {
    const tsconfigPath = findTsconfig(lunoraDirectory);

    return [
        tsconfigPath === undefined ? "" : statKey(tsconfigPath),
        ...projectConfigCandidatePaths(lunoraDirectory)
            .filter((path) => existsSync(path))
            .map((path) => statKey(path)),
    ].join("\n");
};

/** The cached Project for `lunoraDirectory`, refreshed from disk, or a fresh one. */
const studioCodegenProject = (lunoraDirectory: string): CodegenProject => {
    const key = projectKey(lunoraDirectory);

    if (cachedProject?.lunoraDirectory === lunoraDirectory && cachedProject.key === key) {
        refreshCodegenProject(cachedProject.project, lunoraDirectory);

        return cachedProject.project;
    }

    cachedProject = { key, lunoraDirectory, project: createCodegenProject(lunoraDirectory) };

    return cachedProject.project;
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
        // The same join `runCodegen` resolves its directory with, so the seeds match discovery.
        const lunoraDirectory = join(request.projectRoot, request.schemaDirectory ?? "lunora");

        runCodegen({ ...studioCodegenOptions(request), project: studioCodegenProject(lunoraDirectory) });
    } catch (error: unknown) {
        // A failed run can leave the Project half-synced; the next request builds a fresh one.
        cachedProject = undefined;

        if (error instanceof CodegenDiagnosticError) {
            return [error.message];
        }

        throw error;
    }

    return [];
};

export type { StudioCodegenRequest };
export { runStudioCodegen, studioCodegenOptions };
