import { describe, expect, it, vi } from "vitest";

import { LunoraError } from "../src/errors";
import type { ExportFanOutRequest, FanOutRequest, MigrationFanOutRequest, RankFanOutRequest, ShardRegistry } from "../src/query-coordinator";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

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
        idFromName: (name) => {
            return { __name: name };
        },
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

    it("topK — orders rows with missing/non-numeric `by` field deterministically (no NaN comparator)", async () => {
        expect.assertions(2);

        const registry = createStaticShardRegistry({ messages: ["a", "b", "c"] });
        const coordinator = createQueryCoordinator({ registry });

        const rows: Record<string, unknown[]> = {
            a: [{ id: "a1" }, { id: "a2", score: 0.9 }],
            b: [
                { id: "b1", score: "not-a-number" },
                { id: "b2", score: 0.7 },
            ],
            c: [{ id: "c1", score: null }, { id: "c2", score: 0.8 }, { id: "c3" }],
        };

        const spy = createShardSpy((shardKey) => json(rows[shardKey] ?? []));

        const runOnce = () =>
            coordinator.fanOut(
                spy.namespace,
                buildRequest({
                    fanOut: { merge: { by: "score", k: 3, kind: "topK" }, table: "messages" },
                }),
            );

        const first = await runOnce();
        const second = await runOnce();

        expect(first.data).toEqual([
            { id: "a2", score: 0.9 },
            { id: "c2", score: 0.8 },
            { id: "b2", score: 0.7 },
        ]);
        expect(second.data).toEqual(first.data);
    });

    it("topK — sorts close finite values without throwing, highest first in desc", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy(() =>
            json([
                { id: "sum", score: 0.1 + 0.2 },
                { id: "exact", score: 0.3 },
            ]),
        );

        const result = await coordinator.fanOut(
            spy.namespace,
            buildRequest({
                fanOut: { merge: { by: "score", k: 2, kind: "topK" }, table: "messages" },
            }),
        );

        expect(result.data).toEqual([
            { id: "sum", score: 0.1 + 0.2 },
            { id: "exact", score: 0.3 },
        ]);
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

    it("rank — sums per-shard {before,total} into {position: Σbefore+1, total: Σtotal}", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a", "b", "c"] });
        const coordinator = createQueryCoordinator({ registry });

        const perShard: Record<string, { before: number; total: number }> = {
            a: { before: 2, total: 5 },
            b: { before: 0, total: 3 },
            c: { before: 4, total: 6 },
        };

        const spy = createShardSpy((shardKey) => json(perShard[shardKey] ?? { before: 0, total: 0 }));

        const result = await coordinator.fanOut(
            spy.namespace,
            buildRequest({
                fanOut: { merge: { kind: "rank" }, table: "messages" },
            }),
        );

        // Σbefore = 6 → position 7; Σtotal = 14.
        expect(result.data).toEqual({ position: 7, total: 14 });
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

    it("thrown error from a shard becomes an INTERNAL ShardError with the raw message redacted", async () => {
        expect.assertions(5);

        const registry = createStaticShardRegistry({ messages: ["a"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy(() => {
            throw new Error("connect ECONNREFUSED for user=svc-admin pw=SECRET-CONN-STRING");
        });

        const result = await coordinator.fanOut(spy.namespace, buildRequest());

        // `fanOut` reports failures as DATA — the envelope is `Response.json`-ed
        // to the caller — so the per-shard message goes through the same
        // `toErrorBody` shaping as every other error leaving the runtime: a
        // plain `Error` is `INTERNAL` with its text redacted.
        expect(result.failed).toBe(1);
        expect(result.errors[0]?.code).toBe("INTERNAL");
        expect(result.errors[0]?.message).not.toContain("SECRET-CONN-STRING");
        expect(result.errors[0]?.message).not.toContain("svc-admin");
        expect(result.errors[0]?.timedOut).toBe(false);
    });

    it("echoes a catalogued LunoraError code and message from a shard unchanged", async () => {
        expect.assertions(2);

        const registry = createStaticShardRegistry({ messages: ["a"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy(() => {
            throw new LunoraError("row not found", { code: "NOT_FOUND", status: 404 });
        });

        const result = await coordinator.fanOut(spy.namespace, buildRequest());

        expect(result.errors[0]?.code).toBe("NOT_FOUND");
        expect(result.errors[0]?.message).toContain("row not found");
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
            // These cases all register real shard keys, so the fallback is
            // deliberately not wanted — which is now something you must say.
            defaultShardKey: null,
            functionPath: "__lunora_admin__:runMigration",
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
        expect(spy.calls.every((c) => c.body.functionPath === "__lunora_admin__:runMigration")).toBe(true);
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
        expect(result.shards[0]).toMatchObject({ result: { changed: 2, processed: 5, status: "completed" }, shardKey: "a" });
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

        const result = await coordinator.orchestrateMigration(spy.namespace, migrationRequest({ functionPath: "__lunora_admin__:migrationStatus" }));

        expect(result.ok).toBe(2);
        // Top-level counts are 0 — status payloads carry counts per row, not at the top.
        expect(result.changed).toBe(0);
        expect(result.processed).toBe(0);
        expect(result.shards[0]?.result).toMatchObject({ migrations: [{ id: "backfill", status: "completed" }] });
    });
});

describe("orchestrateRank", () => {
    const rankRequest = (overrides: Partial<RankFanOutRequest> = {}): RankFanOutRequest => {
        return {
            headers: { authorization: "Bearer admin" },
            index: "leaderboard",
            partitionKey: "",
            rowId: "u1",
            sortValues: [100],
            table: "scores",
            ...overrides,
        };
    };

    /** Mimic a shard's admin `rankBefore` envelope: `{ result: { before, total } }`. */
    const rankResult = (before: number, total: number): Response => json({ result: { before, total } });

    it("forwards the explicit key + admin bearer to every shard", async () => {
        expect.assertions(5);

        const registry = createStaticShardRegistry({ scores: ["a", "b"] });
        const coordinator = createQueryCoordinator({ registry });
        const spy = createShardSpy(() => rankResult(0, 1));

        await coordinator.orchestrateRank(spy.namespace, rankRequest());

        expect(spy.calls).toHaveLength(2);
        expect(spy.calls.every((c) => c.body.functionPath === "__lunora_admin__:rankBefore")).toBe(true);
        expect(spy.calls.every((c) => c.headers.authorization === "Bearer admin")).toBe(true);
        expect(spy.calls.every((c) => c.body.args.rowId === "u1")).toBe(true);
        expect(spy.calls.every((c) => Array.isArray(c.body.args.sortValues) && (c.body.args.sortValues as number[])[0] === 100)).toBe(true);
    });

    it("sums per-shard {before,total} into the global position + total", async () => {
        expect.assertions(5);

        const registry = createStaticShardRegistry({ scores: ["a", "b", "c"] });
        const coordinator = createQueryCoordinator({ registry });

        const counts: Record<string, [number, number]> = { a: [2, 5], b: [0, 3], c: [4, 6] };
        const spy = createShardSpy((shardKey) => {
            const [before, total] = counts[shardKey] ?? [0, 0];

            return rankResult(before, total);
        });

        const result = await coordinator.orchestrateRank(spy.namespace, rankRequest());

        expect(result.ok).toBe(3);
        expect(result.failed).toBe(0);
        expect(result.position).toBe(7);
        expect(result.total).toBe(14);
        expect(result.shards[0]).toMatchObject({ result: { before: 2, total: 5 }, shardKey: "a" });
    });

    it("no live shards yields position 1, total 0", async () => {
        expect.assertions(2);

        const registry = createStaticShardRegistry({ scores: [] });
        const coordinator = createQueryCoordinator({ registry });
        const spy = createShardSpy(() => rankResult(1, 1));

        const result = await coordinator.orchestrateRank(spy.namespace, rankRequest());

        expect(spy.calls).toHaveLength(0);
        expect(result).toEqual({ failed: 0, ok: 0, partial: false, position: 1, shards: [], total: 0 });
    });

    it("a failed shard surfaces as an error and only contributes the reachable shards' counts", async () => {
        expect.assertions(6);

        const registry = createStaticShardRegistry({ scores: ["a", "b"] });
        const coordinator = createQueryCoordinator({ registry });

        const spy = createShardSpy((shardKey) => (shardKey === "b" ? new Response("boom", { status: 500 }) : rankResult(3, 4)));

        const result = await coordinator.orchestrateRank(spy.namespace, rankRequest());

        expect(result.ok).toBe(1);
        expect(result.failed).toBe(1);
        // A failed shard makes the rank an under-count — surfaced via `partial`.
        expect(result.partial).toBe(true);
        // Only shard "a" counted: Σbefore = 3 → position 4; Σtotal = 4.
        expect(result.position).toBe(4);
        expect(result.total).toBe(4);
        expect(result.shards.find((s) => s.shardKey === "b")?.error?.message).toContain("500");
    });
});

describe("concurrency", () => {
    it("maxConcurrency caps the number of in-flight shard RPCs", async () => {
        expect.assertions(2);

        let inFlight = 0;
        let highWater = 0;

        const registry = createStaticShardRegistry({ messages: Array.from({ length: 10 }, (_, i) => `s${String(i)}`) });
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

        expect(spy.calls.map((call) => call.shardKey).toSorted((a, b) => a.localeCompare(b))).toEqual(["x", "y"]);
        expect(result.ok).toBe(2);
    });
});

describe("orchestrateExport shard discovery", () => {
    // Discovery is registry-driven, and a registry only ever knows the shard keys
    // an app registers for its `.shardBy(...)` tables. A root-DO table has no entry
    // and never will — so without a fallback the fan-out reached zero shards and
    // the export streamed an empty body that reads exactly like "this table has no
    // rows". `orchestrateImport` has always resolved this case to the default
    // shard; these pin export to the same answer.
    it("falls back to the default shard when the registry knows no keys", async () => {
        expect.assertions(2);

        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({}) });
        const spy = createShardSpy(() => json({ ok: true, rows: [{ doc: { _id: "m1" }, table: "messages" }] }));

        const result = await coordinator.orchestrateExport(spy.namespace, { args: {}, defaultShardKey: "__root__", headers: {}, tables: ["messages"] });

        expect(spy.calls.map((call) => call.shardKey)).toEqual(["__root__"]);
        expect(result.shards.flatMap((shard) => shard.rows ?? [])).toHaveLength(1);
    });

    it("reaches the default shard when no tables were named at all", async () => {
        expect.assertions(1);

        // What the worker passes when the caller sends no `tables` and codegen
        // supplied no `listSchemaTables` — the union of zero tables is zero keys.
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ messages: ["chan-1"] }) });
        const spy = createShardSpy(() => json({ ok: true, rows: [] }));

        await coordinator.orchestrateExport(spy.namespace, { args: {}, defaultShardKey: "__root__", headers: {}, tables: [] });

        expect(spy.calls.map((call) => call.shardKey)).toEqual(["__root__"]);
    });

    it("prefers real registry keys over the fallback", async () => {
        expect.assertions(1);

        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ messages: ["chan-1", "chan-2"] }) });
        const spy = createShardSpy(() => json({ ok: true, rows: [] }));

        await coordinator.orchestrateExport(spy.namespace, { args: {}, defaultShardKey: "__root__", headers: {}, tables: ["messages"] });

        expect(spy.calls.map((call) => call.shardKey).toSorted((a, b) => a.localeCompare(b))).toEqual(["chan-1", "chan-2"]);
    });

    it("contacts nothing when the caller passes a null default shard", async () => {
        expect.assertions(1);

        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({}) });
        const spy = createShardSpy(() => json({ ok: true, rows: [] }));

        await coordinator.orchestrateExport(spy.namespace, { args: {}, defaultShardKey: null, headers: {}, tables: ["messages"] });

        expect(spy.calls).toEqual([]);
    });
});

describe("empty shard discovery", () => {
    /**
     * A registry only knows the keys an app registers for its `.shardBy(...)`
     * tables, so a plain root-DO table has no entry and never will. Every fan-out
     * that reads an empty discovery as "nothing to do" reports success having
     * touched nothing — which is how `lunora export` shipped an empty file and how
     * a data migration reported `completed` with `processed: 0`.
     */
    it("runs a migration on the default shard rather than reporting completed over zero shards", async () => {
        expect.assertions(3);

        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({}) });
        const spy = createShardSpy(() => json({ ok: true, result: { changed: 3, processed: 3, status: "completed" } }));

        const result = await coordinator.orchestrateMigration(spy.namespace, {
            args: {},
            defaultShardKey: "__root__",
            functionPath: "__lunora_admin__:runMigration",
            headers: {},
            table: "messages",
        });

        expect(spy.calls.map((call) => call.shardKey)).toEqual(["__root__"]);
        expect(result.ok).toBe(1);
        // The number that made the old behaviour look like success.
        expect(result.processed).toBe(3);
    });

    it("pulls CDC changes from the default shard when no table is registered", async () => {
        expect.assertions(1);

        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({}) });
        const spy = createShardSpy(() => json({ ok: true, result: { changes: [], cursor: 0 } }));

        await coordinator.orchestrateCdcSync(spy.namespace, { defaultShardKey: "__root__", headers: {}, tables: ["messages"] });

        expect(spy.calls.map((call) => call.shardKey)).toEqual(["__root__"]);
    });

    it("still prefers real registry keys over the fallback", async () => {
        expect.assertions(1);

        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ messages: ["a", "b"] }) });
        const spy = createShardSpy(() => json({ ok: true, result: { changed: 0, processed: 0, status: "completed" } }));

        await coordinator.orchestrateMigration(spy.namespace, {
            args: {},
            defaultShardKey: "__root__",
            functionPath: "__lunora_admin__:runMigration",
            headers: {},
            table: "messages",
        });

        expect(spy.calls.map((call) => call.shardKey).toSorted((left, right) => left.localeCompare(right))).toEqual(["a", "b"]);
    });

    /**
     * Regression: `defaultShardKey` was optional on the export / CDC / migration
     * requests, so a fan-out that never mentioned it fell back to nothing and
     * reported success over zero shards — which is how two of the six fan-outs
     * were missed. Omission is no longer expressible; `null` is how a caller
     * says it means it (as `orchestrateRank`'s callers do below).
     */
    it("does not let a fan-out request omit its shard fallback", () => {
        expect.assertions(1);

        // @ts-expect-error - `defaultShardKey` is required
        const omitted: ExportFanOutRequest = { args: {}, headers: {}, tables: ["messages"] };
        // @ts-expect-error - `defaultShardKey` is required
        const omittedMigration: MigrationFanOutRequest = { functionPath: "__lunora_admin__:runMigration", table: "messages" };

        expect([omitted.tables.length, omittedMigration.table]).toEqual([1, "messages"]);
    });

    it("keeps an empty fan-out for a caller that supplies no default", async () => {
        expect.assertions(1);

        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({}) });
        const spy = createShardSpy(() => json({ ok: true }));

        await coordinator.orchestrateRank(spy.namespace, { headers: {}, index: "by_score", partitionKey: "{}", rowId: "p1", sortValues: [1], table: "posts" });

        expect(spy.calls).toEqual([]);
    });
});
