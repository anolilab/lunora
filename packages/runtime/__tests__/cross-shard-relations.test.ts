import { describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import { createCrossShardRelationCapabilities } from "../src/cross-shard-relations";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * End-to-end cover for reverse cross-backend relations: the
 * `createCrossShardRelationCapabilities` reader/counter fan a shard-local child
 * read out across every shard through the real worker `/_cirrus/rpc` → coordinator
 * path. Two in-memory shards stand in for real ShardDOs — each serves the reserved
 * `__cirrus_relation__:read`/`:count` RPC by returning a BARE value (row array /
 * number), exactly as the generated ShardDO override does, so the coordinator's
 * `concat`/`sum` merge composes them.
 */
const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

interface ShardObservation {
    args: Record<string, unknown>;
    functionPath: string;
    shardKey: string;
    userId: null | string;
}

interface ShardCluster {
    namespace: ShardNamespaceLike;
    seen: ShardObservation[];
}

const createShardCluster = (rowsByShard: Record<string, Record<string, unknown>[]>, countByShard: Record<string, number>): ShardCluster => {
    const seen: ShardObservation[] = [];

    const namespace: ShardNamespaceLike = {
        get: (id) => {
            const shardKey = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    const body = await request.json();

                    seen.push({ args: body.args, functionPath: body.functionPath, shardKey, userId: request.headers.get("x-cirrus-userid") });

                    if (body.functionPath === "__cirrus_relation__:read") {
                        return Response.json(rowsByShard[shardKey] ?? []);
                    }

                    if (body.functionPath === "__cirrus_relation__:count") {
                        return Response.json(countByShard[shardKey] ?? 0);
                    }

                    return new Response("not found", { status: 404 });
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return { namespace, seen };
};

/**
 * Build a worker over the cluster with a coordinator wired to a static two-shard
 * registry for the `local` table. `authorizeFanOut` permits the reserved relation
 * paths; `resolveIdentity` honours the forwarded `x-cirrus-userid` so the test can
 * assert identity propagation reaches each shard (an internal-trust endpoint).
 */
const buildWorker = (cluster: ShardCluster): ReturnType<typeof createWorker> =>
    createWorker({
        authorizeFanOut: (_identity, _table, functionPath) => functionPath.startsWith("__cirrus_relation__:"),
        queryCoordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ local: ["s1", "s2"] }) }),
        resolveIdentity: async (request) => {
            const userId = request.headers.get("x-cirrus-userid");

            return userId !== null && userId.length > 0 ? { userId } : null;
        },
        shardDO: cluster.namespace,
    });

describe("createCrossShardRelationCapabilities", () => {
    it("fans a `read` out across every shard and concatenates the rows", async () => {
        expect.assertions(3);

        const cluster = createShardCluster({ s1: [{ _id: "l1", name: "A" }], s2: [{ _id: "l2", name: "B" }] }, {});
        const worker = buildWorker(cluster);
        const capabilities = createCrossShardRelationCapabilities({
            fetch: ((request: Request) => worker.fetch(request, {}, fakeContext)) as typeof globalThis.fetch,
            origin: "https://worker.test",
            userId: "user_42",
        });

        const page = await capabilities.crossShardReader("local", { where: { _id: { in: ["l1", "l2"] } } });

        expect(page.page).toHaveLength(2);
        expect(page.page.map((row) => row["_id"]).toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(["l1", "l2"]);
        // Identity is forwarded to BOTH shards (the worker honoured x-cirrus-userid).
        expect(cluster.seen.filter((entry) => entry.functionPath === "__cirrus_relation__:read").map((entry) => entry.userId)).toEqual(["user_42", "user_42"]);
    });

    it("fans a `count` out across every shard and sums the per-shard tallies", async () => {
        expect.assertions(1);

        const cluster = createShardCluster({}, { s1: 2, s2: 3 });
        const worker = buildWorker(cluster);
        const capabilities = createCrossShardRelationCapabilities({
            fetch: ((request: Request) => worker.fetch(request, {}, fakeContext)) as typeof globalThis.fetch,
            origin: "https://worker.test",
            userId: "user_42",
        });

        const total = await capabilities.crossShardCounter("local", { globalId: "g1" });

        expect(total).toBe(5);
    });

    it("forwards the per-relation `where` (FK filter) to each shard", async () => {
        expect.assertions(2);

        const cluster = createShardCluster({ s1: [{ _id: "l1" }], s2: [] }, {});
        const worker = buildWorker(cluster);
        const capabilities = createCrossShardRelationCapabilities({
            fetch: ((request: Request) => worker.fetch(request, {}, fakeContext)) as typeof globalThis.fetch,
            origin: "https://worker.test",
        });

        await capabilities.crossShardReader("local", { where: { globalId: { in: ["g1"] } } });

        const reads = cluster.seen.filter((entry) => entry.functionPath === "__cirrus_relation__:read");

        expect(reads).toHaveLength(2);
        expect(reads[0]?.args).toMatchObject({ table: "local", where: { globalId: { in: ["g1"] } } });
    });

    it("rejects the reserved relation RPC dispatched to a single shard (fan-out-only)", async () => {
        expect.assertions(2);

        const cluster = createShardCluster({ s1: [{ _id: "l1" }] }, {});
        const worker = buildWorker(cluster);

        const response = await worker.fetch(
            new Request("https://worker.test/_cirrus/rpc", {
                body: JSON.stringify({ args: { table: "local" }, functionPath: "__cirrus_relation__:read", shardKey: "s1" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
        // The shard must NOT have been reached — the gate fires before dispatch.
        expect(cluster.seen).toHaveLength(0);
    });

    it("denies the fan-out when `authorizeFanOut` rejects the reserved path", async () => {
        expect.assertions(1);

        const cluster = createShardCluster({ s1: [{ _id: "l1" }] }, {});
        const worker = createWorker({
            authorizeFanOut: () => false,
            queryCoordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ local: ["s1", "s2"] }) }),
            shardDO: cluster.namespace,
        });
        const capabilities = createCrossShardRelationCapabilities({
            fetch: ((request: Request) => worker.fetch(request, {}, fakeContext)) as typeof globalThis.fetch,
            origin: "https://worker.test",
        });

        await expect(capabilities.crossShardReader("local", { where: {} })).rejects.toThrow(/worker returned 403/u);
    });
});
