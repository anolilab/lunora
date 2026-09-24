import { RELATION_FUNCTION_PREFIX } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import { createCrossShardRelationCapabilities } from "../src/cross-shard-relations";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * End-to-end cover for reverse cross-backend relations: the
 * `createCrossShardRelationCapabilities` reader/counter fan a shard-local child
 * read out across every shard through the real worker `/_lunora/rpc` → coordinator
 * path. Two in-memory shards stand in for real ShardDOs — each serves the reserved
 * `__lunora_relation__:read`/`:count` RPC by returning a BARE value (row array /
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
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- workers-types Request.json() is typed `unknown` under tsc (eslint's view sees `any`); the cast is required by `lint:types`
                    const body = (await request.json()) as { args: Record<string, unknown>; functionPath: string };

                    seen.push({ args: body.args, functionPath: body.functionPath, shardKey, userId: request.headers.get("x-lunora-userid") });

                    if (body.functionPath === "__lunora_relation__:read") {
                        return Response.json(rowsByShard[shardKey] ?? []);
                    }

                    if (body.functionPath === "__lunora_relation__:count") {
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
 * paths; `resolveIdentity` honours the forwarded `x-lunora-userid` so the test can
 * assert identity propagation reaches each shard (an internal-trust endpoint).
 */
const buildWorker = (cluster: ShardCluster): ReturnType<typeof createWorker> =>
    createWorker({
        authorizeFanOut: (_identity, _table, functionPath) => functionPath.startsWith("__lunora_relation__:"),
        queryCoordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ local: ["s1", "s2"] }) }),
        resolveIdentity: async (request) => {
            const userId = request.headers.get("x-lunora-userid");

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
        // Identity is forwarded to BOTH shards (the worker honoured x-lunora-userid).
        expect(cluster.seen.filter((entry) => entry.functionPath === "__lunora_relation__:read").map((entry) => entry.userId)).toEqual(["user_42", "user_42"]);
    });

    it("decodes the shard's wire-encoded rows, so a bigint arrives as a bigint", async () => {
        expect.assertions(3);

        // The producing shard runs `encodeWire` on its relation result, so bigints
        // and byte arrays land as `["$lunora.wire$", …]` tags. Without the matching
        // `decodeWire` here, every child row's 64-bit id reaches the parent as a
        // tag ARRAY instead of a value.
        const row = encodeWire({ _id: "l1", blob: new Uint8Array([1, 2, 3]), views: 9_007_199_254_740_993n }) as Record<string, unknown>;
        const cluster = createShardCluster({ s1: [row], s2: [] }, {});
        const worker = buildWorker(cluster);
        const capabilities = createCrossShardRelationCapabilities({
            fetch: ((request: Request) => worker.fetch(request, {}, fakeContext)) as typeof globalThis.fetch,
            origin: "https://worker.test",
            userId: "user_42",
        });

        const page = await capabilities.crossShardReader("local", { where: {} });

        expect(page.page).toHaveLength(1);
        expect(page.page[0]?.["views"]).toBe(9_007_199_254_740_993n);
        expect(page.page[0]?.["blob"]).toStrictEqual(new Uint8Array([1, 2, 3]));
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

        const reads = cluster.seen.filter((entry) => entry.functionPath === "__lunora_relation__:read");

        expect(reads).toHaveLength(2);
        expect(reads[0]?.args).toMatchObject({ table: "local", where: { globalId: { in: ["g1"] } } });
    });

    it("rejects the reserved relation RPC dispatched to a single shard (fan-out-only)", async () => {
        expect.assertions(2);

        const cluster = createShardCluster({ s1: [{ _id: "l1" }] }, {});
        const worker = buildWorker(cluster);

        const response = await worker.fetch(
            new Request("https://worker.test/_lunora/rpc", {
                body: JSON.stringify({ args: { table: "local" }, functionPath: "__lunora_relation__:read", shardKey: "s1" }),
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

    it("denies the fan-out when `authorizeFanOut` returns a truthy non-boolean", async () => {
        expect.assertions(1);

        // This gate stands in front of the RLS-blind `__lunora_relation__:*`
        // cross-shard raw-row reads, so a truthy-but-not-`true` verdict from an
        // untyped app gate would expose every shard's rows.
        const cluster = createShardCluster({ s1: [{ _id: "l1" }] }, {});
        const worker = createWorker({
            authorizeFanOut: () => ({ valid: false }) as unknown as boolean,
            queryCoordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ local: ["s1", "s2"] }) }),
            shardDO: cluster.namespace,
        });
        const capabilities = createCrossShardRelationCapabilities({
            fetch: ((request: Request) => worker.fetch(request, {}, fakeContext)) as typeof globalThis.fetch,
            origin: "https://worker.test",
        });

        await expect(capabilities.crossShardReader("local", { where: {} })).rejects.toThrow(/worker returned 403/u);
    });

    it("default-denies the reserved fan-out under the open posture (no authorize* configured)", async () => {
        expect.assertions(2);

        // SECURITY: a worker with NEITHER `authorizeFanOut` NOR `authorizeShard`
        // runs the historical open posture. A normal function fan-out is merely
        // warned-and-allowed there, but the reserved relation read (raw,
        // RLS-blind, function-less) must be hard-denied so it can't become a
        // full-table exfiltration primitive.
        const cluster = createShardCluster({ s1: [{ _id: "l1" }] }, {});
        const worker = createWorker({
            queryCoordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ local: ["s1", "s2"] }) }),
            shardDO: cluster.namespace,
        });
        const capabilities = createCrossShardRelationCapabilities({
            fetch: ((request: Request) => worker.fetch(request, {}, fakeContext)) as typeof globalThis.fetch,
            origin: "https://worker.test",
        });

        await expect(capabilities.crossShardReader("local", { where: {} })).rejects.toThrow(/worker returned 403/u);
        // The denial fires before dispatch — no shard was reached.
        expect(cluster.seen).toHaveLength(0);
    });

    it("throws on a partial fan-out (a failing shard) instead of returning truncated rows", async () => {
        expect.assertions(1);

        // s1 serves its row; s2 errors (500). The coordinator returns 200 with s1
        // merged + s2 in `errors` — but a relation read must be all-or-nothing.
        const namespace: ShardNamespaceLike = {
            get: (id) => {
                const shardKey = (id as { __name: string }).__name;

                return {
                    fetch: async () => (shardKey === "s2" ? new Response("boom", { status: 500 }) : Response.json([{ _id: "l1" }])),
                };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        };
        const worker = createWorker({
            authorizeFanOut: () => true,
            queryCoordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ local: ["s1", "s2"] }) }),
            shardDO: namespace,
        });
        const capabilities = createCrossShardRelationCapabilities({
            fetch: ((request: Request) => worker.fetch(request, {}, fakeContext)) as typeof globalThis.fetch,
            origin: "https://worker.test",
        });

        await expect(capabilities.crossShardReader("local", { where: {} })).rejects.toThrow(/failed on 1 of 2 shard\(s\)/u);
    });

    it("keeps the worker's fan-out-only gate in sync with @lunora/do's reserved prefix", async () => {
        expect.assertions(2);

        // Drift guard: the worker's single-shard rejection (create-worker.ts) and
        // the DO's interception (@lunora/do) both hinge on the SAME reserved
        // prefix literal across a security boundary. `@lunora/do` is a type-only
        // devDep of the runtime, so the prefix can't be imported into runtime
        // SOURCE — but the test may value-import it to assert the worker rejects
        // exactly `<prefix>read` on a single-shard envelope.
        expect(RELATION_FUNCTION_PREFIX).toBe("__lunora_relation__:");

        const cluster = createShardCluster({ s1: [{ _id: "l1" }] }, {});
        const worker = buildWorker(cluster);

        const response = await worker.fetch(
            new Request("https://worker.test/_lunora/rpc", {
                body: JSON.stringify({ args: { table: "local" }, functionPath: `${RELATION_FUNCTION_PREFIX}read`, shardKey: "s1" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
    });
});
