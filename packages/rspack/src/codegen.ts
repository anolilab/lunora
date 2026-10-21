import { existsSync } from "node:fs";
import { join } from "node:path";

import { createCodegenProject, refreshCodegenProject, runCodegen } from "@lunora/codegen";
import type { FindingLogger } from "@lunora/config";
import { blockingFindingsMessage, LUNORA_TAG, reportCodegenFindings, STRICT_ADVISORIES_ENV, writeApiSpecMarker } from "@lunora/config";
import { reconcileWranglerExtras, wranglerCodegenInputs } from "@lunora/config/cloudflare";
import type { Project } from "ts-morph";

import type { ResolvedLunoraRspackOptions } from "./types";

/** The three channels this module reports through — `console` satisfies it, as does Rspack's `Logger`. */
interface CodegenLogger extends FindingLogger {
    info: (message: string) => void;
}

/** {@link runCodegenPass}'s result: each field is set only when that step failed or escalates. */
interface CodegenPassResult {
    /** An ERROR-level advisory or platform diagnostic; the caller decides whether it stops a build. */
    blockingMessage?: string;
    /** `.lunora/api-spec.json` could not be written. Output exists anyway, so dev logs it and keeps going. */
    markerFailure?: string;
}

/**
 * Run `@lunora/codegen` once and report everything it found.
 *
 * Never throws for a *schema* problem — advisories and platform diagnostics are
 * logged and folded into the returned blocking message, so the caller decides
 * whether they stop a build. A codegen *crash* (an unparseable `lunora/`, a
 * non-static cron expression) does throw: that is broken input the developer must
 * see, and the caller turns it into a compilation error rather than letting it
 * reject a hook.
 *
 * A missing `schema.ts` is the normal state of an uninitialised project, so it
 * warns and returns `undefined` rather than failing — matching `lunora codegen`.
 *
 * Returns the blocking message, or `undefined` when nothing is ERROR-level.
 */
const runCodegenPass = (options: ResolvedLunoraRspackOptions, logger: CodegenLogger, project?: Project): CodegenPassResult => {
    const schemaPath = join(options.projectRoot, options.schemaDir, "schema.ts");

    if (!existsSync(schemaPath)) {
        logger.warn(`${LUNORA_TAG} no schema found at ${schemaPath} — run \`lunora init\` or create it, then rebuild.`);

        return {};
    }

    const result = runCodegen({
        apiSpec: options.apiSpec,
        lazyFunctions: options.lazyFunctions,
        lunoraDirectory: options.schemaDir,
        project,
        projectRoot: options.projectRoot,
        target: options.target,
        ...wranglerCodegenInputs(options.projectRoot),
    });

    reconcileWranglerExtras(options.projectRoot, result.cronTriggers, logger);

    // Outside the throw path above: the output is already written, so a marker that cannot be recorded must not stop the
    // post-codegen hook from running. The caller decides whether it fails the build.
    let markerFailure: string | undefined;

    try {
        writeApiSpecMarker(options.projectRoot, options.apiSpec);
    } catch (error: unknown) {
        markerFailure = `${LUNORA_TAG} could not write the API spec marker: ${error instanceof Error ? error.message : String(error)}`;

        logger.error(markerFailure);
    }

    reportCodegenFindings(result, logger);

    return {
        blockingMessage: blockingFindingsMessage(result, { strictAdvisories: process.env[STRICT_ADVISORIES_ENV] !== "0" }),
        markerFailure,
    };
};

/**
 * A ts-morph `Project` reused across rebuilds, refreshed from disk before each
 * pass. Re-parsing the user's whole TS program on every save is the difference
 * between a sub-second and a multi-second rebuild, which is the entire reason
 * codegen exposes `createCodegenProject` / `refreshCodegenProject`.
 *
 * `drop()` discards the cached program. Two callers need it, both borrowed from
 * `@lunora/vite`, which learned them the hard way: a run that THREW leaves the
 * Project partially mutated, so reusing it risks emitting wrong code off a
 * corrupted program; and a `tsconfig.json` change (a new path alias, a changed
 * `include`) is invisible to `refreshCodegenProject`, which only re-reads files
 * the program already knows about.
 */
const createReusableProject = (lunoraDirectory: string): { drop: () => void; get: () => Project } => {
    let project: Project | undefined;

    return {
        drop: (): void => {
            project = undefined;
        },
        get: (): Project => {
            if (project === undefined) {
                project = createCodegenProject(lunoraDirectory);
            } else {
                refreshCodegenProject(project, lunoraDirectory);
            }

            return project;
        },
    };
};

export type { CodegenLogger };
export { createReusableProject, runCodegenPass };
