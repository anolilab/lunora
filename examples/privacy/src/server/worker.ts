import type { ShardNamespaceLike } from "lunorash/runtime";
import { createWorker } from "lunorash/runtime";

import { LUNORA_CRONS } from "../../lunora/_generated/crons.js";
import { openApiSpec } from "../../lunora/_generated/openapi.js";

/** The bindings the Worker reads. The workflows and the tombstone store are reached from their own code. */
interface WorkerEnv {
    SHARD: ShardNamespaceLike;
}

/**
 * The app's Worker. `cronJobs` is the dispatcher map codegen emits from `lunora/crons.ts`: on a firing
 * trigger, `scheduled()` runs each job's internal function in the shard, server-side, so a client can
 * never reach it. Kept apart from the entry so a test can fire a trigger without the Durable Object classes.
 */
const buildWorker = (env: WorkerEnv): ReturnType<typeof createWorker> => createWorker({ cronJobs: LUNORA_CRONS, openApiSpec, shardDO: env.SHARD });

export type { WorkerEnv };
export { buildWorker };
