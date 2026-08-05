/**
 * Shared core behind the per-kind `*-info.ts` discovery modules (agents,
 * workflows, containers, queues, flags): probe for the declaring file under
 * `lunora/`, run the `@lunora/codegen` discovery call in a fresh ts-morph
 * project, and fold a parse failure into an error message. A missing file is
 * not an error (`{}`); callers decide whether a parse error is a warning
 * (validator) or ignorable (inference).
 */
import { existsSync } from "node:fs";

import { Project } from "ts-morph";

import join from "./path";

interface DiscoverIrResult<T> {
    /** Parse error message, when the file exists but could not be analyzed. */
    error?: string;
    /** The discovery result; absent when the file is missing or parsing failed. */
    value?: T;
}

const discoverIr = <T>(
    projectRoot: string,
    schemaDirectory: string,
    filename: string,
    discover: (project: Project, directory: string) => T,
    projectOptions: ConstructorParameters<typeof Project>[0] = {},
): DiscoverIrResult<T> => {
    if (!existsSync(join(projectRoot, schemaDirectory, filename))) {
        return {};
    }

    try {
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false, ...projectOptions });

        return { value: discover(project, join(projectRoot, schemaDirectory)) };
    } catch (error: unknown) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
};

export type { DiscoverIrResult };
export { discoverIr };
