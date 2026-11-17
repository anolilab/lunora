/**
 * Spend from a named limit on the root shard. Every shard's `ratelimit_buckets`
 * is its own, so an action's `ctx.runMutation` draws from whichever shard the
 * caller reached; the root's bucket is the one budget all shards share.
 */
import { env as workerEnv } from "cloudflare:workers";
import type { ShardNamespaceLike } from "lunorash/runtime";
import { createShardClient } from "lunorash/runtime";

import { internal } from "../_generated/internal";
import type { LimitName } from "./schema";

export const spendRootBudget = async (name: LimitName, key: string): Promise<{ ok: boolean; retryAfter?: number }> =>
    createShardClient((workerEnv as unknown as { SHARD: ShardNamespaceLike }).SHARD, { shardKey: "__root__" }).call(internal.ratelimit.consume, {
        key,
        name,
    });
