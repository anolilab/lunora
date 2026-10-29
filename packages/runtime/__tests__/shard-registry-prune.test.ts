import { describe, expect, it } from "vitest";

import type { ExecutionContextLike, ShardingInfo, WorkerOptions } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const ADMIN_TOKEN = "admin-bear";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const SHARDING: Record<string, ShardingInfo> = {
    messages: { mode: { field: "channelId", kind: "shardBy" } },
    threads: { mode: { field: "channelId", kind: "shardBy" } },
    users: { mode: { kind: "root" } },
};

/** A shard namespace whose `c1` releases `threads` and keeps the rest, and whose `c2` is down. */
const shardNamespace = (): { calls: { args: unknown; shardKey: string }[]; namespace: ShardNamespaceLike } => {
    const calls: { args: unknown; shardKey: string }[] = [];

    return {
        calls,
        namespace: {
            get: (id) => {
                const shardKey = (id as { name: string }).name;

                return {
                    fetch: async (request: Request) => {
                        const { args }: { args: { tables: string[] } } = await request.json();

                        calls.push({ args, shardKey });

                        if (shardKey === "c2") {
                            return new Response("down", { status: 500 });
                        }

                        return Response.json({
                            result: { kept: args.tables.filter((table) => table !== "threads"), released: args.tables.filter((table) => table === "threads") },
                        });
                    },
                };
            },
            idFromName: (name) => {
                return { name };
            },
        },
    };
};

const worker = (namespace: ShardNamespaceLike, options: Partial<WorkerOptions> = {}): ReturnType<typeof createWorker> =>
    createWorker({
        adminToken: ADMIN_TOKEN,
        listSchemaTables: () => Object.keys(SHARDING),
        queryCoordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ messages: ["c1", "c2"], threads: ["c1"] }) }),
        resolveTableSharding: (table) => SHARDING[table],
        shardDO: namespace,
        ...options,
    });

const prune = async (target: ReturnType<typeof createWorker>, body: unknown, token = ADMIN_TOKEN): Promise<Response> =>
    target.fetch(
        new Request("https://app.example/_lunora/admin/shard-registry/prune", {
            body: JSON.stringify(body),
            headers: { authorization: `Bearer ${token}` },
            method: "POST",
        }),
        {},
        fakeContext,
    );

describe("pOST /_lunora/admin/shard-registry/prune", () => {
    it("asks each listed shard once for all its tables, and reports an unreachable one as failed (207)", async () => {
        expect.assertions(3);

        const { calls, namespace } = shardNamespace();
        const response = await prune(worker(namespace), { dryRun: true });

        expect(response.status).toBe(207);
        await expect(response.json()).resolves.toStrictEqual({
            failed: [{ message: expect.stringContaining('shard "c2" returned 500'), shardKey: "c2", tables: ["messages"] }],
            kept: [{ shardKey: "c1", table: "messages" }],
            released: [{ shardKey: "c1", table: "threads" }],
        });
        // Every `.shardBy()` table by default, grouped per shard, the dry-run flag forwarded.
        expect(calls.toSorted((a, b) => a.shardKey.localeCompare(b.shardKey))).toStrictEqual([
            { args: { dryRun: true, tables: ["messages", "threads"] }, shardKey: "c1" },
            { args: { dryRun: true, tables: ["messages"] }, shardKey: "c2" },
        ]);
    });

    it("drops a caching registry's listing for every table it released from", async () => {
        expect.assertions(1);

        const invalidated: (string | undefined)[] = [];
        const registry = { ...createStaticShardRegistry({ messages: ["c1"], threads: ["c1"] }), invalidate: (table?: string) => invalidated.push(table) };

        await prune(worker(shardNamespace().namespace, { queryCoordinator: createQueryCoordinator({ registry }) }), {});

        expect(invalidated).toStrictEqual(["threads"]);
    });

    it("refuses a table that is not .shardBy()", async () => {
        expect.assertions(1);

        const response = await prune(worker(shardNamespace().namespace), { tables: ["users"] });

        expect(response.status).toBe(400);
    });

    it("requires the admin bearer", async () => {
        expect.assertions(1);

        const response = await prune(worker(shardNamespace().namespace), {}, "wrong");

        expect(response.status).toBe(403);
    });

    it("answers 400 when the worker has no shard registry to prune", async () => {
        expect.assertions(1);

        const response = await prune(worker(shardNamespace().namespace, { queryCoordinator: undefined }), {});

        expect(response.status).toBe(400);
    });
});
