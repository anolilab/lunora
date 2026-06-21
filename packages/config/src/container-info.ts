/**
 * Single source of truth for the container facts both the wrangler validator
 * and binding inference need — mirrors `schema-info.ts`: derive the facts from
 * one `@lunora/codegen` discovery call so inference and validation can never
 * disagree about what `lunora/containers.ts` declares.
 */
import { existsSync } from "node:fs";

import type { ContainerIR } from "@lunora/codegen";
import { CONTAINERS_FILENAME, discoverContainers } from "@lunora/codegen";
import { Project } from "ts-morph";

import join from "./path";

interface DiscoverContainerInfoResult {
    /** Discovered container definitions; `[]` when none are declared or parsing failed. */
    containers: ReadonlyArray<ContainerIR>;
    /** Parse error message, when `lunora/containers.ts` exists but could not be analyzed. */
    error?: string;
}

/**
 * Discover the project's `defineContainer` declarations. Returns
 * `{ containers: [] }` when the project has no `lunora/containers.ts` (not an
 * error), or `{ containers: [], error }` when the file exists but could not be
 * parsed — callers decide whether that is a warning (validator) or ignorable
 * (inference).
 */
const discoverContainerInfo = (projectRoot: string, schemaDirectory: string): DiscoverContainerInfoResult => {
    const containersPath = join(projectRoot, schemaDirectory, CONTAINERS_FILENAME);

    if (!existsSync(containersPath)) {
        return { containers: [] };
    }

    try {
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        return { containers: discoverContainers(project, join(projectRoot, schemaDirectory)) };
    } catch (error: unknown) {
        return { containers: [], error: error instanceof Error ? error.message : String(error) };
    }
};

export type { DiscoverContainerInfoResult };
export { discoverContainerInfo };

export { type ContainerIR } from "@lunora/codegen";
