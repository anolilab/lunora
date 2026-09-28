import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { blockingFindingsMessage, createCodegenProject, refreshCodegenProject, runCodegen } from "@lunora/codegen";
import { advisoryLine, LUNORA_TAG } from "@lunora/config";
import { collectWranglerSecretVariables, reconcileWranglerExtras } from "@lunora/config/cloudflare";
import type { Project } from "ts-morph";

import type { ResolvedLunoraRspackOptions } from "./types";

/** The three channels this module reports through — Rspack's `Logger` satisfies it, as does `console`. */
interface CodegenLogger {
    error: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
}

/** Outcome of one codegen pass. `blockingMessage` is set only when a build must fail. */
interface CodegenPass {
    /**
     * Why the build should fail: an ERROR-level advisory or an `error` platform
     * diagnostic. Every level is already logged by the time this is returned —
     * this only decides whether the caller escalates.
     */
    blockingMessage?: string;

    /** Absolute path codegen wrote `_generated/*` into, when the run produced output. */
    outputDirectory?: string;
}

/**
 * Run `@lunora/codegen` once and report everything it found.
 *
 * Never throws for a *schema* problem — advisories and platform diagnostics are
 * logged and summarised into {@link CodegenPass.blockingMessage} so the caller
 * decides (a one-shot build fails, a watch rebuild keeps going). A codegen
 * crash* does throw: that is a broken `lunora/` the developer must see.
 *
 * A missing `schema.ts` is the normal state of an uninitialised project, so it
 * warns and returns rather than failing — matching `lunora codegen`.
 */
const runCodegenPass = (options: ResolvedLunoraRspackOptions, logger: CodegenLogger, project?: Project): CodegenPass => {
    const schemaPath = join(options.projectRoot, options.schemaDir, "schema.ts");

    if (!existsSync(schemaPath)) {
        logger.warn(`${LUNORA_TAG} no schema found at ${schemaPath} — run \`lunora init\` or create it, then rebuild.`);

        return {};
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

    for (const advisory of result.advisories) {
        const line = advisoryLine(advisory.level, advisory.name, advisory.detail, advisory.remediation);

        if (advisory.level === "ERROR") {
            logger.error(line);
        } else {
            logger.warn(line);
        }
    }

    for (const diagnostic of result.platformDiagnostics) {
        const line = advisoryLine(diagnostic.level === "error" ? "ERROR" : "WARN", diagnostic.name, diagnostic.message, diagnostic.remediation);

        if (diagnostic.level === "error") {
            logger.error(line);
        } else {
            logger.warn(line);
        }
    }

    // Identical escalation to `@lunora/vite`'s, from the same shared builder: an
    // ERROR advisory says a call throws at runtime, and an `error` platform
    // diagnostic says the emitted surface does not match the declared target.
    return { blockingMessage: blockingFindingsMessage(result, LUNORA_TAG), outputDirectory: resolve(result.outputDirectory) };
};

/**
 * A ts-morph `Project` reused across rebuilds, refreshed from disk before each
 * pass. Re-parsing the user's whole TS program on every save is the difference
 * between a sub-second and a multi-second rebuild, which is the entire reason
 * codegen exposes `createCodegenProject` / `refreshCodegenProject`.
 */
const createReusableProject = (lunoraDirectory: string): { refresh: () => Project } => {
    let project: Project | undefined;

    return {
        refresh: (): Project => {
            if (project === undefined) {
                project = createCodegenProject(lunoraDirectory);
            } else {
                refreshCodegenProject(project, lunoraDirectory);
            }

            return project;
        },
    };
};

export type { CodegenLogger, CodegenPass };
export { createReusableProject, runCodegenPass };
