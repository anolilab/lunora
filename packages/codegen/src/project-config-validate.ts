/**
 * Refusing a `lunora.config.*` that would do something other than what it says.
 *
 * The readers in `project-config-file.ts` look up the keys they know and ignore
 * the rest, so `remot: true` or `codegen: { lazyFuntions: true }` was a config
 * that did nothing and said nothing, and `remote: "true"` read as "no
 * preference". The checks themselves live with the readers, in the same table
 * and the same parse; this is where `runCodegen` turns them into an error.
 */
import { basename } from "node:path";

import { LunoraError } from "@lunora/errors";

import { projectConfigProblems } from "./project-config-file";
import { findCodegenConfigFile, findProjectConfigFile } from "./project-config-path";

/**
 * Refuse the project's config files with an unknown key, a literal of the wrong
 * type, or only named exports. Called by `runCodegen`, which every dev server,
 * build and deploy runs first, so a typo stops the run that would have ignored it.
 *
 * The target is read from the project root and the codegen keys from the schema
 * directory upwards, so both files are checked; usually they are one file.
 * @throws LunoraError `PROJECT_CONFIG_INVALID`, listing every problem.
 */
const assertValidProjectConfigs = (projectRoot: string, lunoraDirectory: string): void => {
    for (const configPath of new Set([findCodegenConfigFile(lunoraDirectory), findProjectConfigFile(projectRoot)])) {
        const problems = configPath === undefined ? [] : projectConfigProblems(configPath);

        if (configPath !== undefined && problems.length > 0) {
            throw new LunoraError("PROJECT_CONFIG_INVALID", `${basename(configPath)} is invalid:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
        }
    }
};

export default assertValidProjectConfigs;
