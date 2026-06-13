import type { D1CtxDbOptions, D1DatabaseLike, D1Exec } from "@cirrus/d1";
import { createD1CtxDb, listGlobalTables, readGlobalTablePage } from "@cirrus/d1";
import type { ExecutionContextLike, GlobalIntrospector, ScheduledControllerLike, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";

import { CIRRUS_CRONS } from "../cirrus/_generated/crons.js";
import { CIRRUS_FUNCTIONS } from "../cirrus/_generated/functions.js";
import { openApiSpec } from "../cirrus/_generated/openapi.js";
import { createShardDO } from "../cirrus/_generated/shard.js";
import schema from "../cirrus/schema.js";
import { createDeployRouter } from "./deploy/router";

/**
 * Cirrus Cloud control-plane Worker — the platform itself, dogfooded on Cirrus
 * (see CLOUD-PLAN.md). This is NOT a tenant Worker; it is the service that
 * provisions and tracks tenant deployments. Its own `.global()` tables
 * (`cells`, `organizations`) live in the control-plane D1 bound as `DB`.
 */

/** Adapt the raw D1 binding to `@cirrus/d1`'s `D1Exec`. */
const buildExec = (database: D1DatabaseLike): D1Exec => {
    return {
        all: async (sql, parameters) => {
            const result = await database
                .prepare(sql)
                .bind(...parameters)
                .all<Record<string, unknown>>();

            return result.results;
        },
        run: async (sql, parameters) => {
            await database
                .prepare(sql)
                .bind(...parameters)
                .run();
        },
    };
};

/** Let the studio's global data browser list/page the `.global()` (D1) tables. */
const d1Introspector = (database: D1DatabaseLike): GlobalIntrospector => {
    const exec = buildExec(database);

    return {
        listTables: () => listGlobalTables(exec, schema as never),
        readTablePage: (options) => readGlobalTablePage(exec, schema as never, options),
    };
};

interface ShardEnv {
    DB?: D1DatabaseLike;
}

/**
 * The control-plane shard DO. `.global()` tables (`cells`, `organizations`)
 * route through the D1 ctx-db; org-scoped tables (`projects`, `deployments`, …)
 * stay in the per-org shard's SQLite.
 */
export const ShardDO = createShardDO({
    d1: (env) => {
        const shardEnv = env as ShardEnv;

        if (!shardEnv.DB) {
            return undefined;
        }

        return createD1CtxDb({
            exec: buildExec(shardEnv.DB),
            schema: schema as unknown as D1CtxDbOptions["schema"],
        });
    },
});

interface Env {
    /** Bearer token gating the admin endpoints the studio + platform tools call. */
    CIRRUS_ADMIN_TOKEN?: string;
    /** Control-plane D1 — backs the `.global()` cells/organizations tables. */
    DB: unknown;
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | null = null;

// The deploy API (`POST /v1/deploy`), mounted as the lowest-priority matcher.
// Created once so its per-cell scheduler persists across requests.
const deployRouter = createDeployRouter();

const buildWorker = (env: Env): ReturnType<typeof createWorker> =>
    createWorker({
        adminToken: env.CIRRUS_ADMIN_TOKEN,
        // Code-first crons (cirrus/crons.ts): the cleanup-expired-previews job
        // fires on the worker's `scheduled()` entry. The control plane is an
        // account-level worker, so its cron triggers fire normally (§2.4).
        cronJobs: CIRRUS_CRONS,
        d1: env.DB,
        functions: CIRRUS_FUNCTIONS,
        globalIntrospector: env.DB ? d1Introspector(env.DB as D1DatabaseLike) : undefined,
        httpRouter: deployRouter,
        openApiSpec,
        routes: {},
        shardDO: env.SHARD,
    });

export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        worker ??= buildWorker(env);

        return worker.fetch(request, env, context);
    },
    async scheduled(controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike): Promise<void> {
        worker ??= buildWorker(env);

        await worker.scheduled(controller, env, context);
    },
};
