import { handleAuthRequest } from "@lunora/auth";
import type { ExecutionContextLike, ScheduledControllerLike } from "lunorash/runtime";

import { createShardDO } from "../../lunora/_generated/shard.js";
import { authFor } from "./auth";
import type { WorkerEnv } from "./worker";
import { buildWorker } from "./worker";

// The two Workflow classes must be exported from the entry, or wrangler provisions no binding for them.
export * from "../../lunora/_generated/workflows.js";

// The erasure tombstones' own Durable Object (`PRIVACY_TOMBSTONES`), outside the shard.
export { PrivacyTombstonesDO } from "./privacy-tombstones-do";

export const ShardDO = createShardDO();

let worker: ReturnType<typeof buildWorker> | undefined;

/**
 * Minimal Worker entry. The privacy package's request tables live in the shard, and its
 * durable workflows run from the generated Workflow classes. Only the tombstones have
 * their own binding, so a restore of the shard cannot roll them back.
 */
export default {
    async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
        // Sign-in is better-auth's own router, mounted before Lunora's. Everything else falls through.
        const authResponse = await handleAuthRequest(await authFor(env), request);

        if (authResponse) {
            return authResponse;
        }

        worker ??= buildWorker(env);

        return worker.fetch(request, env, ctx);
    },

    /**
     * Cron entry. Cloudflare fires it for each expression in `wrangler.jsonc`'s `triggers.crons`, and the
     * worker dispatches the jobs `lunora/crons.ts` declares: the deadline check and the housekeeping
     * sweep. Without this export the triggers fire into nothing.
     */
    async scheduled(controller: ScheduledControllerLike, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void> {
        worker ??= buildWorker(env);

        await worker.scheduled(controller, env, ctx);
    },
};
