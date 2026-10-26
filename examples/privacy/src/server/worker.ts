import type { ShardNamespaceLike } from "lunorash/runtime";
import { createWorker } from "lunorash/runtime";

import { LUNORA_CRONS } from "../../lunora/_generated/crons.js";
import { openApiSpec } from "../../lunora/_generated/openapi.js";
import { app } from "../../lunora/http";
import { authFor } from "./auth";

/** The bindings the Worker reads. The workflows and the tombstone store are reached from their own code. */
interface WorkerEnv {
    AUTH_SECRET: string;
    DB: unknown;
    SHARD: ShardNamespaceLike;
}

/**
 * The app's Worker. `cronJobs` is the dispatcher map codegen emits from `lunora/crons.ts`: on a firing
 * trigger, `scheduled()` runs each job's internal function in the shard, server-side, so a client can
 * never reach it. `httpRouter` mounts `lunora/http.ts`, which serves the download route (`/privacy/files`). Kept
 * apart from the entry so a test can fire a trigger without the Durable Object classes.
 */
const buildWorker = (env: WorkerEnv): ReturnType<typeof createWorker> =>
    createWorker({
        cronJobs: LUNORA_CRONS,
        httpRouter: app,
        openApiSpec,
        // The session's cookie resolves the caller. `iat` is the sign-in time, which the package reads to refuse
        // an erasure from a sign-in older than 24 hours.
        resolveIdentity: async (request) => {
            // A sign-in database that cannot be reached leaves the caller anonymous, which refuses every
            // subject call. It must not fail the request, since a session-free download needs no identity.
            try {
                const auth = await authFor(env);
                const session = await auth.api.getSession({ headers: request.headers });

                return session === null ? null : { iat: Math.floor(session.session.createdAt.getTime() / 1000), userId: session.user.id };
            } catch (error) {
                console.error("sign-in unavailable; caller treated as anonymous", error);

                return null;
            }
        },
        shardDO: env.SHARD,
    });

export type { WorkerEnv };
export { buildWorker };
