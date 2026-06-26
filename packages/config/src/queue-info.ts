/**
 * Single source of truth for the queue facts both the wrangler validator and
 * binding inference need — mirrors `workflow-info.ts`: derive the facts from one
 * `@lunora/codegen` discovery call so inference and validation can never
 * disagree about what `lunora/queues.ts` declares.
 */
import { existsSync } from "node:fs";

import type { QueueIR } from "@lunora/codegen";
import { discoverQueues, QUEUES_FILENAME } from "@lunora/codegen";
import { Project } from "ts-morph";

import join from "./path";

interface DiscoverQueueInfoResult {
    /** Parse error message, when `lunora/queues.ts` exists but could not be analyzed. */
    error?: string;
    /** Discovered queue definitions; `[]` when none are declared or parsing failed. */
    queues: ReadonlyArray<QueueIR>;
}

/**
 * Discover the project's `defineQueue` declarations. Returns `{ queues: [] }`
 * when the project has no `lunora/queues.ts` (not an error), or
 * `{ queues: [], error }` when the file exists but could not be parsed — callers
 * decide whether that is a warning (validator) or ignorable (inference).
 */
const discoverQueueInfo = (projectRoot: string, schemaDirectory: string): DiscoverQueueInfoResult => {
    const queuesPath = join(projectRoot, schemaDirectory, QUEUES_FILENAME);

    if (!existsSync(queuesPath)) {
        return { queues: [] };
    }

    try {
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

        return { queues: discoverQueues(project, join(projectRoot, schemaDirectory)) };
    } catch (error: unknown) {
        return { error: error instanceof Error ? error.message : String(error), queues: [] };
    }
};

export type { DiscoverQueueInfoResult };
export { discoverQueueInfo };

export { type QueueIR } from "@lunora/codegen";
