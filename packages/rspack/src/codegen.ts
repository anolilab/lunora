import { existsSync } from "node:fs";
import { join } from "node:path";

import { createCodegenProject, refreshCodegenProject, runCodegen } from "@lunora/codegen";
import type { FindingLogger } from "@lunora/config";
import { blockingFindingsMessage, LUNORA_TAG, reportCodegenFindings } from "@lunora/config";
import { collectWranglerSecretVariables, reconcileWranglerExtras } from "@lunora/config/cloudflare";
import type { Project } from "ts-morph";

import type { ResolvedLunoraRspackOptions } from "./types";

/** The three channels this module reports through — `console` satisfies it, as does Rspack's `Logger`. */
interface CodegenLogger extends FindingLogger {
    info: (message: string) => void;
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
const runCodegenPass = (options: ResolvedLunoraRspackOptions, logger: CodegenLogger, project?: Project): string | undefined => {
    const schemaPath = join(options.projectRoot, options.schemaDir, "schema.ts");

    if (!existsSync(schemaPath)) {
        logger.warn(`${LUNORA_TAG} no schema found at ${schemaPath} — run \`lunora init\` or create it, then rebuild.`);

        return undefined;
    }

    const result = runCodegen({
        apiSpec: options.apiSpec,
        lunoraDirectory: options.schemaDir,
        project,
        projectRoot: options.projectRoot,
        target: options.target,
        wranglerVariables: collectWranglerSecretVariables(options.projectRoot),
    });

    reconcileWranglerExtras(options.projectRoot, result.cronTriggers, logger);
    reportCodegenFindings(result, logger);

    return blockingFindingsMessage(result);
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
