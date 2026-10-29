/**
 * Single source of truth for the queue facts both the wrangler validator and
 * binding inference need — mirrors `workflow-info.ts`: derive the facts from one
 * `@lunora/codegen` discovery call so inference and validation can never
 * disagree about what `lunora/queues.ts` and the module `queues.ts` files declare.
 */
import type { QueueIR } from "@lunora/codegen";
import { discoverQueues } from "@lunora/codegen";

import { discoverIr } from "./discover-info";

interface DiscoverQueueInfoResult {
    /** Parse error message, when a queues file exists but could not be analyzed. */
    error?: string;
    /** Discovered queue definitions; `[]` when none are declared or parsing failed. */
    queues: ReadonlyArray<QueueIR>;
}

/**
 * Discover the project's `defineQueue` declarations. Returns `{ queues: [] }`
 * when the project declares none (not an error), or `{ queues: [], error }`
 * when a queues file exists but could not be parsed — callers decide whether
 * that is a warning (validator) or ignorable (inference). Queues live in
 * `lunora/queues.ts` and in each module's `queues.ts`, so discovery finds the
 * files rather than `discoverIr` probing one path.
 */
const discoverQueueInfo = (projectRoot: string, schemaDirectory: string): DiscoverQueueInfoResult => {
    const { error, value } = discoverIr(projectRoot, schemaDirectory, undefined, discoverQueues);

    return error === undefined ? { queues: value ?? [] } : { error, queues: [] };
};

export type { DiscoverQueueInfoResult };
export { discoverQueueInfo };

export { type QueueIR } from "@lunora/codegen";
