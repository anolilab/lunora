import { describe, expect, it } from "vitest";

import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

interface ShardCall {
    body: { args: Record<string, unknown>; functionPath: string };
    shardKey: string;
}

interface ShardSpy {
    calls: ShardCall[];
    namespace: ShardNamespaceLike;
}

const createShardSpy = (handler: (shardKey: string, body: { args: Record<string, unknown> }) => Promise<Response> | Response): ShardSpy => {
    const calls: ShardCall[] = [];

    const stubFor = (shardKey: string) => {
 return {
        async fetch(request: Request): Promise<Response> {
            const body: { args: Record<string, unknown>; functionPath: string } = await request.json();

            calls.push({ body, shardKey });

            return handler(shardKey, body);
        },
    };
};

    const namespace: ShardNamespaceLike = {
        get: (id) => stubFor((id as { __name: string }).__name),
        idFromName: (name) => { return { __name: name }; },
    };

    return { calls, namespace };
};

const json = (value: unknown): Response => Response.json(value, { headers: { "content-type": "application/json" }, status: 200 });

describe("orchestrateExport", () => {
    it("fans out exportShard across every live shard for the requested tables", async () => {
        expect.assertions(5);

        const registry = createStaticShardRegistry({ messages: ["c1", "c2", "c3"], users: [] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((shardKey) => json({ result: { rows: [{ doc: { _id: shardKey }, table: "messages" }] } }));

        const result = await coordinator.orchestrateExport(spy.namespace, {
            tables: ["messages"],
        });

        expect(result.ok).toBe(3);
        expect(result.failed).toBe(0);
        expect(result.shards).toHaveLength(3);

        const allRows = result.shards.flatMap((s) => s.rows ?? []);

        expect(allRows).toHaveLength(3);
        expect(spy.calls.every((c) => c.body.functionPath === "__cirrus_admin__:exportShard")).toBe(true);
    });

    it("rolls up errors per shard without throwing", async () => {
        expect.assertions(3);

        const registry = createStaticShardRegistry({ messages: ["c1", "c2"] });
        const coordinator = createQueryCoordinator({ registry, perShardTimeoutMs: 100 });

        const spy = createShardSpy((shardKey) => {
            if (shardKey === "c2") {
                return Response.json({ error: { code: "BOOM", message: "broken" } }, { status: 500 });
            }

            return json({ result: { rows: [{ doc: { _id: "ok" }, table: "messages" }] } });
        });

        const result = await coordinator.orchestrateExport(spy.namespace, { tables: ["messages"] });

        expect(result.ok).toBe(1);
        expect(result.failed).toBe(1);

        const failed = result.shards.find((s) => s.error);

        expect(failed?.shardKey).toBe("c2");
    });

    it("unions live shard keys across multiple tables", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["c1", "c2"], notifications: ["c2", "c3"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy(() => json({ result: { rows: [] } }));

        await coordinator.orchestrateExport(spy.namespace, { tables: ["messages", "notifications"] });

        const visited = new Set(spy.calls.map((c) => c.shardKey));

        expect(visited).toEqual(new Set(["c1", "c2", "c3"]));
    });
});

describe("orchestrateImport", () => {
    it("forwards one batch per shard and sums the inserted counts", async () => {
        expect.assertions(3);

        const registry = createStaticShardRegistry({ messages: ["c1", "c2"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((_shardKey, body) => {
            const rows = (body.args["rows"] as unknown[]) ?? [];

            return json({ result: { conflicts: 0, errors: [], inserted: { messages: rows.length } } });
        });

        const result = await coordinator.orchestrateImport(spy.namespace, {
            batches: [
                {
                    rows: [
                        { doc: { _id: "m1", channelId: "c1", text: "hi" }, table: "messages" },
                        { doc: { _id: "m2", channelId: "c1", text: "yo" }, table: "messages" },
                    ],
                    shardKey: "c1",
                },
                {
                    rows: [{ doc: { _id: "m3", channelId: "c2", text: "ok" }, table: "messages" }],
                    shardKey: "c2",
                },
            ],
        });

        expect(result.inserted).toEqual({ messages: 3 });
        expect(result.ok).toBe(2);
        expect(result.failed).toBe(0);
    });

    it("collects per-shard errors but does not throw", async () => {
        expect.assertions(4);

        const registry = createStaticShardRegistry({ messages: ["c1", "c2"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((shardKey) => {
            if (shardKey === "c2") {
                return Response.json({ error: { code: "BOOM", message: "broken" } }, { status: 500 });
            }

            return json({
                result: { conflicts: 0, errors: [{ code: "VALIDATION_ERROR", line: 1, message: "bad", table: "messages" }], inserted: { messages: 1 } },
            });
        });

        const result = await coordinator.orchestrateImport(spy.namespace, {
            batches: [
                { rows: [{ doc: { _id: "m1", channelId: "c1", text: "hi" }, table: "messages" }], shardKey: "c1" },
                { rows: [{ doc: { _id: "m2", channelId: "c2", text: "yo" }, table: "messages" }], shardKey: "c2" },
            ],
        });

        expect(result.ok).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatchObject({ code: "VALIDATION_ERROR", line: 1 });
    });
});
