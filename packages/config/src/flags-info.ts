/**
 * Single source of truth for the feature-flag facts both the wrangler validator
 * and binding inference need — mirrors `queue-info.ts`: derive the facts from one
 * `@lunora/codegen` discovery call so inference and validation can never
 * disagree about the `flagship` binding `lunora/flags.ts` implies.
 */
import { existsSync } from "node:fs";

import type { FlagsIR } from "@lunora/codegen";
import { discoverFlags, FLAGS_FILENAME } from "@lunora/codegen";
import { Project } from "ts-morph";

import join from "./path";

interface DiscoverFlagsInfoResult {
    /** Parse error message, when `lunora/flags.ts` exists but could not be analyzed. */
    error?: string;
    /** The declared flag provider, or `undefined` when the project has no `lunora/flags.ts`. */
    flags?: FlagsIR;
}

/**
 * Discover the project's `defineFlags` provider. Returns `{}` when the project
 * has no `lunora/flags.ts` (not an error), or `{ error }` when the file exists
 * but could not be parsed — callers decide whether that is a warning (validator)
 * or ignorable (inference).
 */
const discoverFlagsInfo = (projectRoot: string, schemaDirectory: string): DiscoverFlagsInfoResult => {
    const flagsPath = join(projectRoot, schemaDirectory, FLAGS_FILENAME);

    if (!existsSync(flagsPath)) {
        return {};
    }

    try {
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        return { flags: discoverFlags(project, join(projectRoot, schemaDirectory)) };
    } catch (error: unknown) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
};

export type { DiscoverFlagsInfoResult };
export { discoverFlagsInfo };

export type { FlagsIR } from "@lunora/codegen";
