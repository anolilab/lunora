import { describe, expect, it, vi } from "vitest";

import type { FanOutRequest, MigrationFanOutRequest, ShardRegistry } from "../src/query-coordinator.js";
import {
    createQueryCoordinator,
    createStaticShardRegistry,
} from "../src/query-coordinator.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

interface ShardCall {
    body: { args: Record<string, unknown>; functionPath: string };
    headers: Record<string, string>;
    shardKey: string;
}

interface ShardSpy {
    calls: ShardCall[];
    namespace: ShardNamespaceLike;
}

const createShardSpy = (handler: (shardKey: string) => Promise<Response> | Response): ShardSpy => {
    const calls: ShardCall[] = [];

    const stubFor = (shardKey: string) => {
 return {
        async fetch(request: Request): Promise<Response> {
            const body: { args: Record<string, unknown>; functionPath: string } = await request.json();
            const headers: Record<string, string> = {};

            request.headers.forEach((value, key) => {
                headers[key] = value;
            });

            calls.push({ body, headers, shardKey });

            return handler(shardKey);
        },
    };
};

    const namespace: ShardNamespaceLike = {
        get: (id) => stubFor((id as { __name: string }).__name),
        getByName: (name) => stubFor(name),
        idFromName: (name) => { return { __name: name }; },
    };

    return { calls, namespace };
};

const json = (value: unknown, init?: ResponseInit): Response => Response.json(value, { headers: { "content-type": "application/json" }, status: 200, ...init });

const buildRequest = (overrides: Partial<FanOutRequest> = {}): FanOutRequest => {
 return {
    args: {},
    fanOut: { merge: { kind: "concat" }, table: "messages" },
    functionPath: "messages:list",
    ...overrides,
};
};

describe("createStaticShardRegistry", () => {
    it("returns the configured keys for a known table", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a", "b", "c"] });
        const keys = await registry.listShardKeys("messages");

        expect([...keys]).toEqual(["a", "b", "c"]);
    });

    it("returns empty array for unknown tables", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a"] });
        const keys = await registry.listShardKeys("nope");

        expect([...keys]).toEqual([]);
    });
});

describe("createQueryCoordinator", () => {
    it("rejects maxConcurrency < 1", () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({});

        expect(() => createQueryCoordinator({ maxConcurrency: 0, registry })).toThrow(/maxConcurrency must be >= 1/);
    });

    it("returns merge-strategy identity when no shards are registered", async () => {
        expect.assertions(2);

        const registry = createStaticShardRegistry({ messages: [] });
        const coordinator = createQueryCoordinator({ registry });
        const spy = createShardSpy(() => json(["row"]));

        const result = await coordinator.fanOut(spy.namespace, buildRequest());

        expect(spy.calls).toHaveLength(0);
        expect(result).toEqual({ data: [], errors: [], failed: 0, ok: 0 });
    });

    it("forwards `headers` and `args` to every shard", async () => {
        expect.assertions(4);

        const registry = createStaticShardRegistry({ messages: ["a", "b"] });
        const coordinator = createQueryCoordinator({ registry });
        const spy = createShardSpy(() => json([]));

        await coordinator.fanOut(
            spy.namespace,
            buildRequest({
                args: { q: "hello" },
                headers: { authorization: "Bearer x", cookie: "k=v" },
            }),
        );

        expect(spy.calls).toHaveLength(2);
        expect(spy.calls.every((c) => c.body.args.q === "hello")).toBe(true);
        expect(spy.calls.every((c) => c.headers.authorization === "Bearer x")).toBe(true);
        expect(spy.calls.every((c) => c.headers.cookie === "k=v")).toBe(true);
    });
});

describe("merge strategies", () => {
    it("concat — flattens arrays from each shard", async () => {
        expect.assertions(3);

        const registry = createStaticShardRegistry({ messages: ["a", "b", "c"] });
        const coordinator = createQueryCoordinator({ registry });

        const perShard: Record<string, unknown[]> = {
            a: [{ id: 1 }],
            b: [{ id: 2 }, { id: 3 }],
            c: [],
        };

        const spy = createShardSpy((shardKey) => json(perShard[shardKey] ?? []));

        const result = await coordinator.fanOut(
            spy.namespace,
            buildRequest({
                fanOut: { merge: { kind: "concat" }, table: "messages" },
            }),
        );

        expect(result.ok).toBe(3);
        expect(result.failed).toBe(0);
        expect(result.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    it("sum — adds numeric results across shards", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a", "b", "c"] });
        const coordinator = createQueryCoordinator({ registry });

        const counts: Record<string, number> = { a: 7, b: 3, c: 12 };

        const spy = createShardSpy((shardKey) => json(counts[shardKey]));

        const result = await coordinator.fanOut(
            spy.namespace,
            buildRequest({
                fanOut: { merge: { kind: "sum" }, table: "messages" },
            }),
        );

        expect(result.data).toBe(22);
    });

    it("topK — picks top K rows ordered by `by` field, desc by default", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a", "b", "c"] });
        const coordinator = createQueryCoordinator({ registry });

        const rows: Record<string, unknown[]> = {
            a: [
                { id: "a1", score: 0.5 },
                { id: "a2", score: 0.9 },
            ],
            b: [{ id: "b1", score: 0.7 }],
            c: [
                { id: "c1", score: 0.8 },
                { id: "c2", score: 0.1 },
            ],
        };

        const spy = createShardSpy((shardKey) => json(rows[shardKey] ?? []));

        const result = await coordinator.fanOut(
            spy.namespace,
            buildRequest({
                fanOut: { merge: { by: "score", k: 3, kind: "topK" }, table: "messages" },
            }),
        );

        expect(result.data).toEqual([
            { id: "a2", score: 0.9 },
            { id: "c1", score: 0.8 },
            { id: "b1", score: 0.7 },
        ]);
    });

    it("topK — supports asc direction", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy(() => json([{ x: 3 }, { x: 1 }, { x: 2 }]));

        const result = await coordinator.fanOut(
            spy.namespace,
            buildRequest({
                fanOut: { merge: { by: "x", direction: "asc", k: 2, kind: "topK" }, table: "messages" },
            }),
        );

        expect(result.data).toEqual([{ x: 1 }, { x: 2 }]);
    });

    it("first — returns the first successful shard's value", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a", "b"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((shardKey) => json({ from: shardKey }));

        const result = await coordinator.fanOut(
            spy.namespace,
            buildRequest({
                fanOut: { merge: { kind: "first" }, table: "messages" },
            }),
        );

        expect(result.data).toEqual({ from: "a" });
    });
});

describe("error handling", () => {
    it("non-2xx response from a shard becomes a ShardError, others still merge", async () => {
        expect.assertions(7);

        const registry = createStaticShardRegistry({ messages: ["a", "b", "c"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((shardKey) => {
            if (shardKey === "b") {
                return new Response("kaboom", { status: 500 });
            }

            return json([{ shard: shardKey }]);
        });

        const result = await coordinator.fanOut(spy.namespace, buildRequest());

        expect(result.ok).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.shardKey).toBe("b");
        expect(result.errors[0]?.timedOut).toBe(false);
        expect(result.errors[0]?.message).toContain("500");
        expect(result.data).toEqual([{ shard: "a" }, { shard: "c" }]);
    });

    it("thrown error from a shard becomes a ShardError", async () => {
        expect.assertions(3);

        const registry = createStaticShardRegistry({ messages: ["a"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy(() => {
            throw new Error("network down");
        });

        const result = await coordinator.fanOut(spy.namespace, buildRequest());

        expect(result.failed).toBe(1);
        expect(result.errors[0]?.message).toContain("network down");
        expect(result.errors[0]?.timedOut).toBe(false);
    });

    it("slow shard hits the per-shard timeout", async () => {
        expect.assertions(5);

        vi.useFakeTimers();

        try {
            const registry = createStaticShardRegistry({ messages: ["fast", "slow"] });
            const coordinator = createQueryCoordinator({ perShardTimeoutMs: 100, registry });

            const spy = createShardSpy(async (shardKey) => {
                if (shardKey === "slow") {
                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, 10_000);
                    });
                }

                return json([{ from: shardKey }]);
            });

            const pending = coordinator.fanOut(spy.namespace, buildRequest());

            await vi.advanceTimersByTimeAsync(200);

            const result = await pending;

            expect(result.ok).toBe(1);
            expect(result.failed).toBe(1);
            expect(result.errors[0]?.shardKey).toBe("slow");
            expect(result.errors[0]?.timedOut).toBe(true);
            expect(result.data).toEqual([{ from: "fast" }]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("orchestrateMigration", () => {
    const migrationRequest = (overrides: Partial<MigrationFanOutRequest> = {}): MigrationFanOutRequest => {
 return {
        args: { id: "backfill" },
        functionPath: "__cirrus_admin__:runMigration",
        headers: { authorization: "Bearer admin" },
        table: "messages",
        ...overrides,
    };
};

    /** Mimic a shard's admin `runMigration` envelope: `{ result: MigrationRunResult }`. */
    const runResult = (changed: number, processed: number, status = "completed"): Response =>
        json({ result: { changed, cursor: null, direction: "up", dryRun: false, id: "backfill", processed, status } });

    it("forwards the admin bearer and migration args to every shard", async () => {
        expect.assertions(4);

        const registry = createStaticShardRegistry({ messages: ["a", "b"] });
        const coordinator = createQueryCoordinator({ registry });
        const spy = createShardSpy(() => runResult(2, 5));

        await coordinator.orchestrateMigration(spy.namespace, migrationRequest({ args: { dryRun: true, id: "backfill" } }));

        expect(spy.calls).toHaveLength(2);
        expect(spy.calls.every((c) => c.body.functionPath === "__cirrus_admin__:runMigration")).toBe(true);
        expect(spy.calls.every((c) => c.headers.authorization === "Bearer admin")).toBe(true);
        expect(spy.calls.every((c) => c.body.args.dryRun === true)).toBe(true);
    });

    it("sums counts and reports completed when every shard finishes", async () => {
        expect.assertions(7);

        const registry = createStaticShardRegistry({ messages: ["a", "b", "c"] });
        const coordinator = createQueryCoordinator({ registry });

        const counts: Record<string, [number, number]> = { a: [2, 5], b: [3, 4], c: [0, 6] };
        const spy = createShardSpy((shardKey) => {
            const [changed, processed] = counts[shardKey] ?? [0, 0];

            return runResult(changed, processed);
        });

        const result = await coordinator.orchestrateMigration(spy.namespace, migrationRequest());

        expect(result.ok).toBe(3);
        expect(result.failed).toBe(0);
        expect(result.changed).toBe(5);
        expect(result.processed).toBe(15);
        expect(result.status).toBe("completed");
        expect(result.shards).toHaveLength(3);
        expect(result.shards[0]).toMatchObject({ shardKey: "a", result: { changed: 2, processed: 5, status: "completed" } });
    });

    it("rolls up to failed when any shard's runner reports failure", async () => {
        expect.assertions(2);

        const registry = createStaticShardRegistry({ messages: ["a", "b"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((shardKey) => (shardKey === "b" ? runResult(1, 1, "failed") : runResult(2, 2)));

        const result = await coordinator.orchestrateMigration(spy.namespace, migrationRequest());

        expect(result.ok).toBe(2);
        expect(result.status).toBe("failed");
    });

    it("rolls up to in_progress when a shard is cut short by maxBatches", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a", "b"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((shardKey) => (shardKey === "b" ? runResult(2, 2, "in_progress") : runResult(2, 2)));

        const result = await coordinator.orchestrateMigration(spy.namespace, migrationRequest());

        expect(result.status).toBe("in_progress");
    });

    it("an unreachable shard surfaces as an error and leaves the run in_progress", async () => {
        expect.assertions(5);

        const registry = createStaticShardRegistry({ messages: ["a", "b"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((shardKey) => {
            if (shardKey === "b") {
                return new Response("boom", { status: 500 });
            }

            return runResult(4, 4);
        });

        const result = await coordinator.orchestrateMigration(spy.namespace, migrationRequest());

        expect(result.ok).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.changed).toBe(4);
        expect(result.status).toBe("in_progress");
        expect(result.shards.find((s) => s.shardKey === "b")?.error?.message).toContain("500");
    });

    it("no live shards yields an empty, completed roll-up", async () => {
        expect.assertions(2);

        const registry = createStaticShardRegistry({ messages: [] });
        const coordinator = createQueryCoordinator({ registry });
        const spy = createShardSpy(() => runResult(1, 1));

        const result = await coordinator.orchestrateMigration(spy.namespace, migrationRequest());

        expect(spy.calls).toHaveLength(0);
        expect(result).toEqual({ changed: 0, failed: 0, ok: 0, processed: 0, shards: [], status: "completed" });
    });

    it("status calls pass through each shard's payload without inventing counts", async () => {
        expect.assertions(4);

        const registry = createStaticShardRegistry({ messages: ["a", "b"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((shardKey) =>
            json({ result: { migrations: [{ changed: 9, id: "backfill", processed: 9, shardKey, status: "completed" }] } }),
        );

        const result = await coordinator.orchestrateMigration(spy.namespace, migrationRequest({ functionPath: "__cirrus_admin__:migrationStatus" }));

        expect(result.ok).toBe(2);
        // Top-level counts are 0 — status payloads carry counts per row, not at the top.
        expect(result.changed).toBe(0);
        expect(result.processed).toBe(0);
        expect(result.shards[0]?.result).toMatchObject({ migrations: [{ id: "backfill", status: "completed" }] });
    });
});

describe("concurrency", () => {
    it("maxConcurrency caps the number of in-flight shard RPCs", async () => {
        expect.assertions(2);

        let inFlight = 0;
        let highWater = 0;

        const registry = createStaticShardRegistry({ messages: Array.from({ length: 10 }, (_, i) => `s${i}`) });
        const coordinator = createQueryCoordinator({ maxConcurrency: 3, registry });

        const spy = createShardSpy(async () => {
            inFlight += 1;
            highWater = Math.max(highWater, inFlight);

            await new Promise<void>((resolve) => {
                setTimeout(resolve, 10);
            });

            inFlight -= 1;

            return json([]);
        });

        await coordinator.fanOut(spy.namespace, buildRequest());

        expect(highWater).toBeLessThanOrEqual(3);
        expect(spy.calls).toHaveLength(10);
    });

    it("registry that returns Promise of keys is awaited", async () => {
        expect.assertions(3);

        const asyncRegistry: ShardRegistry = {
            async listShardKeys(table) {
                expect(table).toBe("messages");

                await new Promise<void>((resolve) => {
                    setTimeout(resolve, 5);
                });

                return ["x", "y"];
            },
        };

        const coordinator = createQueryCoordinator({ registry: asyncRegistry });
        const spy = createShardSpy(() => json([]));

        const result = await coordinator.fanOut(spy.namespace, buildRequest());

        expect(spy.calls.map((c) => c.shardKey).sort()).toEqual(["x", "y"]);
        expect(result.ok).toBe(2);
    });
});
