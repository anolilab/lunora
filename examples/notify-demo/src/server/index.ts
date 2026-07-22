import type { D1Like } from "@lunora/notify";
import type { ExecutionContextLike, ShardNamespaceLike } from "lunorash/runtime";
import { createWorker } from "lunorash/runtime";

import notifyConfig from "../../lunora/notify.js";
import { openApiSpec } from "../../lunora/_generated/openapi.js";
import { createShardDO } from "../../lunora/_generated/shard.js";

// The generated ShardDO wires `ctx.notify` / `ctx.push` from `lunora/notify.ts`
// (codegen discovers the default export) onto every handler ctx.
export const ShardDO = createShardDO();

// Extends `Record<string, unknown>` so it satisfies `@lunora/notify`'s `NotifyEnv`
// when handed to `notifyConfig.store(env)` below (the config factories read
// bindings/secrets off a plain env record).
interface Env extends Record<string, unknown> {
    DB: D1Like;
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | null = null;

/**
 * Worker entry. Beyond the ShardDO binding, it threads the SAME `@lunora/notify`
 * subscription store the handlers register into onto `notifySubscriptionStore`,
 * so the Studio Notifications page can read registered devices through the gated
 * `__lunora_admin__:listPushSubscriptions` admin RPC (default-closed — a valid
 * admin bearer is required).
 */
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        if (!worker) {
            worker = createWorker({
                notifySubscriptionStore: notifyConfig.store?.(env),
                openApiSpec,
                shardDO: env.SHARD,
            });
        }

        return worker.fetch(request, env, ctx);
    },
};
