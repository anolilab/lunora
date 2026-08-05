/**
 * Single source of truth for the container facts both the wrangler validator
 * and binding inference need — mirrors `schema-info.ts`: derive the facts from
 * one `@lunora/codegen` discovery call so inference and validation can never
 * disagree about what `lunora/containers.ts` declares.
 */
import type { ContainerIR } from "@lunora/codegen";
import { CONTAINERS_FILENAME, discoverContainers } from "@lunora/codegen";

import { discoverIr } from "./discover-info";

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
    // skipFileDependencyResolution: container discovery only AST-walks
    // containers.ts and resolves the local `defineContainer` import specifier
    // (which lives in this file). Without this flag ts-morph eagerly loads the
    // imported module's declarations (@lunora/container, …); from a scaffold/
    // temp workdir where those aren't resolvable it can stall for tens of
    // seconds in CI — manifesting as a deploy-test timeout.
    const { error, value } = discoverIr(projectRoot, schemaDirectory, CONTAINERS_FILENAME, discoverContainers, { skipFileDependencyResolution: true });

    return error === undefined ? { containers: value ?? [] } : { containers: [], error };
};

export type { DiscoverContainerInfoResult };
export { discoverContainerInfo };

export { type ContainerIR } from "@lunora/codegen";
