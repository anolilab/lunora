import { describe, expect, it } from "vitest";

import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

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
        idFromName: (name) => {
            return { __name: name };
        },
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
            defaultShardKey: null,
            tables: ["messages"],
        });

        expect(result.ok).toBe(3);
        expect(result.failed).toBe(0);
        expect(result.shards).toHaveLength(3);

        const allRows = result.shards.flatMap((s) => s.rows ?? []);

        expect(allRows).toHaveLength(3);
        expect(spy.calls.every((c) => c.body.functionPath === "__lunora_admin__:exportShard")).toBe(true);
    });

    it("rolls up errors per shard without throwing", async () => {
        expect.assertions(3);

        const registry = createStaticShardRegistry({ messages: ["c1", "c2"] });
        const coordinator = createQueryCoordinator({ perShardTimeoutMs: 100, registry });

        const spy = createShardSpy((shardKey) => {
            if (shardKey === "c2") {
                return Response.json({ error: { code: "BOOM", message: "broken" } }, { status: 500 });
            }

            return json({ result: { rows: [{ doc: { _id: "ok" }, table: "messages" }] } });
        });

        const result = await coordinator.orchestrateExport(spy.namespace, { defaultShardKey: null, tables: ["messages"] });

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

        await coordinator.orchestrateExport(spy.namespace, { defaultShardKey: null, tables: ["messages", "notifications"] });

        const visited = new Set(spy.calls.map((c) => c.shardKey));

        expect(visited).toEqual(new Set(["c1", "c2", "c3"]));
    });

    it("still reaches the default shard for a root table once another table has registered keys", async () => {
        expect.assertions(1);

        // `users` is a plain root-DO table: the registry has no entry for it and
        // never will, so its keys resolve to the default shard. `messages` is
        // `.shardBy()`-ed and registered. Unioning first and falling back only on
        // an empty union dropped the default shard the moment ANY table had a
        // key, so every root-table row was missing from a whole-deployment export.
        const registry = createStaticShardRegistry({ messages: ["c1"], users: [] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy(() => json({ result: { rows: [] } }));

        await coordinator.orchestrateExport(spy.namespace, { defaultShardKey: "__root__", tables: ["users", "messages"] });

        const visited = new Set(spy.calls.map((c) => c.shardKey));

        expect(visited).toEqual(new Set(["__root__", "c1"]));
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

describe("orchestrateCdcSync", () => {
    it("fans out cdcSync with each shard's own cursor and rolls up pages", async () => {
        expect.assertions(5);

        const registry = createStaticShardRegistry({ messages: ["c1", "c2"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((shardKey, body) => {
            const since = Number(body.args["sinceSeq"] ?? 0);

            return json({ result: { changes: [{ id: `${shardKey}-x`, op: "insert", seq: since + 1 }], cursor: since + 1 } });
        });

        const result = await coordinator.orchestrateCdcSync(spy.namespace, { cursors: { c1: 10 }, defaultShardKey: null, tables: ["messages"] });

        expect(result.ok).toBe(2);
        expect(result.failed).toBe(0);
        // c1 resumes from its supplied cursor (10 → 11); c2 defaults to 0 → 1.
        expect(result.shards.find((shard) => shard.shardKey === "c1")?.cursor).toBe(11);
        expect(result.shards.find((shard) => shard.shardKey === "c2")?.cursor).toBe(1);
        expect(spy.calls.every((call) => call.body.functionPath === "__lunora_admin__:cdcSync")).toBe(true);
    });

    it("echoes the prior cursor when a shard errors", async () => {
        expect.assertions(2);

        const registry = createStaticShardRegistry({ messages: ["c1"] });
        const coordinator = createQueryCoordinator({ perShardTimeoutMs: 100, registry });

        const spy = createShardSpy(() => Response.json({ error: { code: "BOOM", message: "broken" } }, { status: 500 }));

        const result = await coordinator.orchestrateCdcSync(spy.namespace, { cursors: { c1: 42 }, defaultShardKey: null, tables: ["messages"] });

        expect(result.failed).toBe(1);
        expect(result.shards[0]?.cursor).toBe(42);
    });

    it("forwards each shard's own sinceEpoch and reports the epoch it came back with", async () => {
        expect.assertions(4);

        const registry = createStaticShardRegistry({ messages: ["c1", "c2"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((shardKey) => json({ result: { changes: [], cursor: 1, epoch: `live-${shardKey}` } }));

        const result = await coordinator.orchestrateCdcSync(spy.namespace, {
            cursors: { c1: 1 },
            defaultShardKey: null,
            // Only c1 holds one — a caller's epoch map is as partial as its
            // cursor map, and c2 must still be read the pre-epoch way.
            epochs: { c1: "held-c1" },
            tables: ["messages"],
        });

        const argsFor = (shardKey: string): Record<string, unknown> | undefined => spy.calls.find((call) => call.shardKey === shardKey)?.body.args;

        expect(argsFor("c1")?.["sinceEpoch"]).toBe("held-c1");
        expect(argsFor("c2")?.["sinceEpoch"]).toBeUndefined();
        expect(result.shards.find((shard) => shard.shardKey === "c1")?.epoch).toBe("live-c1");
        expect(result.shards.find((shard) => shard.shardKey === "c2")?.epoch).toBe("live-c2");
    });

    it("echoes the prior epoch beside the prior cursor when a shard errors", async () => {
        expect.assertions(2);

        const registry = createStaticShardRegistry({ messages: ["c1"] });
        const coordinator = createQueryCoordinator({ perShardTimeoutMs: 100, registry });

        const spy = createShardSpy(() => Response.json({ error: { code: "CDC_TIMELINE_FORKED", message: "forked" } }, { status: 409 }));

        const result = await coordinator.orchestrateCdcSync(spy.namespace, {
            cursors: { c1: 42 },
            defaultShardKey: null,
            epochs: { c1: "held-c1" },
            tables: ["messages"],
        });

        // Both halves of the pair survive the error. Dropping the epoch would
        // silently downgrade the caller to the watermark-only guarantee on its
        // next poll — the exact degradation this field exists to prevent.
        expect(result.shards[0]?.cursor).toBe(42);
        expect(result.shards[0]?.epoch).toBe("held-c1");
    });

    it("distinguishes a forked timeline from a trimmed log and from a transient failure", async () => {
        expect.assertions(4);

        const registry = createStaticShardRegistry({ messages: ["c1", "c2", "c3"] });
        const coordinator = createQueryCoordinator({ perShardTimeoutMs: 100, registry });

        const spy = createShardSpy((shardKey) => {
            if (shardKey === "c1") {
                return Response.json({ error: { code: "CDC_TIMELINE_FORKED", message: "re-seed from a snapshot at epoch live-c1" } }, { status: 409 });
            }

            if (shardKey === "c2") {
                return Response.json({ error: { code: "CDC_LOG_TRIMMED", message: "resume from a snapshot" } }, { status: 409 });
            }

            return Response.json({ error: { code: "INTERNAL", message: "internal error" } }, { status: 500 });
        });

        const result = await coordinator.orchestrateCdcSync(spy.namespace, { cursors: {}, defaultShardKey: null, tables: ["messages"] });

        const errorFor = (shardKey: string): undefined | { code: string; message: string } => result.shards.find((shard) => shard.shardKey === shardKey)?.error;

        // Three refusals that demand three different consumer responses: re-seed
        // from a snapshot on the new timeline, re-seed from a snapshot, retry.
        // Read off the status alone they are one indistinguishable transport
        // failure, and the whole value of the epoch guard is the verdict it
        // reaches the caller with.
        expect(errorFor("c1")?.code).toBe("CDC_TIMELINE_FORKED");
        expect(errorFor("c2")?.code).toBe("CDC_LOG_TRIMMED");
        expect(errorFor("c3")?.code).toBe("INTERNAL");
        // The shard's own remedy rides along with it, already `toErrorBody`-shaped
        // on the shard side, so a connector can log something actionable.
        expect(errorFor("c1")?.message).toContain("re-seed from a snapshot");
    });

    it("falls back to SHARD_HTTP_ERROR when a non-2xx carries no error envelope", async () => {
        expect.assertions(3);

        const registry = createStaticShardRegistry({ messages: ["c1"] });
        const coordinator = createQueryCoordinator({ perShardTimeoutMs: 100, registry });

        // The DO's own router answers an unrouted path with bare text, and a
        // platform 5xx can carry no body at all. Neither is a shard verdict, so
        // neither may be reported as one.
        const spy = createShardSpy(() => new Response("Not found", { status: 404 }));

        const result = await coordinator.orchestrateCdcSync(spy.namespace, { cursors: { c1: 7 }, defaultShardKey: null, tables: ["messages"] });

        expect(result.shards[0]?.error?.code).toBe("SHARD_HTTP_ERROR");
        expect(result.shards[0]?.error?.message).toContain("404");
        expect(result.shards[0]?.cursor).toBe(7);
    });
});

describe("orchestrateApplyCdc", () => {
    it("forwards each per-shard batch and sums the applied counts", async () => {
        expect.assertions(3);

        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({}) });
        const spy = createShardSpy((_shardKey, body) => json({ result: { applied: (body.args["changes"] as unknown[]).length } }));

        const result = await coordinator.orchestrateApplyCdc(spy.namespace, {
            batches: [
                { changes: [{ id: "a" }, { id: "b" }], shardKey: "c1" },
                { changes: [{ id: "c" }], shardKey: "c2" },
            ],
        });

        expect(result.ok).toBe(2);
        expect(result.applied).toBe(3);
        expect(spy.calls.every((call) => call.body.functionPath === "__lunora_admin__:applyCdc")).toBe(true);
    });

    it("counts a shard error as failed without throwing", async () => {
        expect.assertions(2);

        const coordinator = createQueryCoordinator({ perShardTimeoutMs: 100, registry: createStaticShardRegistry({}) });
        const spy = createShardSpy(() => Response.json({ error: { code: "BOOM", message: "x" } }, { status: 500 }));

        const result = await coordinator.orchestrateApplyCdc(spy.namespace, { batches: [{ changes: [{ id: "a" }], shardKey: "c1" }] });

        expect(result.failed).toBe(1);
        expect(result.applied).toBe(0);
    });
});
