import type { ShardNamespaceLike } from "../../../src/index";
import { createWorker, loadStudioDocument } from "../../../src/index";

interface Env {
    ASSETS: unknown;
}

/** No request in the test reaches a shard. */
const shardDO: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("no shard", { status: 500 }) };
    },
    idFromName: (name) => {
        return { name };
    },
};

let worker: ReturnType<typeof createWorker> | undefined;

/** Wired the way the generated app wires a Worker whose Studio documents ship as assets. */
export default {
    fetch: async (
        request: Request,
        env: Env,
        context: { passThroughOnException: () => void; waitUntil: (promise: Promise<unknown>) => void },
    ): Promise<Response> => {
        worker ??= createWorker({
            adminToken: "studio-assets-admin",
            openApiSpec: () => loadStudioDocument(env.ASSETS, "openapi"),
            shardDO,
        });

        return worker.fetch(request, env, context);
    },
};
