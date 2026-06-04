import { beforeEach, describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import type { ObservabilityEvent, ObservabilitySink } from "../src/observability.js";
import { emitRpcEvent } from "../src/observability.js";
import type { QueryCoordinator } from "../src/query-coordinator.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

interface ShardSpy {
    namespace: ShardNamespaceLike;
    response: Response;
    /** When set, the stub fetch rejects with this error instead of returning a response. */
    throwOnFetch?: Error;
}

const createShardSpy = (response = new Response("ok", { status: 200 })): ShardSpy => {
    const spy = { response } as ShardSpy;

    spy.namespace = {
        get: () => {
            return {
                fetch: async () => {
                    if (spy.throwOnFetch) {
                        throw spy.throwOnFetch;
                    }

                    return spy.response;
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return spy;
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const collectEvents = (): { events: ObservabilityEvent[]; sink: ObservabilitySink } => {
    const events: ObservabilityEvent[] = [];

    return {
        events,
        sink: {
            onRpc: (event) => {
                events.push(event);
            },
        },
    };
};

describe("observabilitySink", () => {
    describe("emitRpcEvent", () => {
        it("no-ops when sink is undefined", () => {
            expect.assertions(1);

            expect(() => {
                emitRpcEvent(undefined, { durationMs: 1, functionPath: "x:y", ok: true });
            }).not.toThrow();
        });

        it("no-ops when onRpc is unset", () => {
            expect.assertions(1);

            expect(() => {
                emitRpcEvent({}, { durationMs: 1, functionPath: "x:y", ok: true });
            }).not.toThrow();
        });

        it("swallows sink callback errors", () => {
            expect.assertions(1);

            const sink: ObservabilitySink = {
                onRpc: () => {
                    throw new Error("sink exploded");
                },
            };

            expect(() => {
                emitRpcEvent(sink, { durationMs: 1, functionPath: "x:y", ok: true });
            }).not.toThrow();
        });

        it("forwards the event when onRpc is set", () => {
            expect.assertions(1);

            const { events, sink } = collectEvents();

            emitRpcEvent(sink, { durationMs: 42, functionPath: "messages:list", ok: true, shardKey: "channel-1" });

            expect(events).toEqual([{ durationMs: 42, functionPath: "messages:list", ok: true, shardKey: "channel-1" }]);
        });
    });

    describe("createWorker integration", () => {
        let shard: ShardSpy;

        beforeEach(() => {
            shard = createShardSpy();
        });

        it("emits one onRpc event per single-shard dispatch", async () => {
            expect.assertions(8);

            const { events, sink } = collectEvents();
            const worker = createWorker({ observability: sink, shardDO: shard.namespace });

            const response = await worker.fetch(
                new Request("https://app.example/_cirrus/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(response.status).toBe(200);
            expect(events).toHaveLength(1);
            expect(events[0]!.functionPath).toBe("messages:list");
            expect(events[0]!.ok).toBe(true);
            expect(events[0]!.shardKey).toBe("__root__");
            expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
            expect(events[0]!.fanOut).toBeUndefined();
            expect(events[0]!.error).toBeUndefined();
        });

        it("includes envelope shardKey in event", async () => {
            expect.assertions(1);

            const { events, sink } = collectEvents();
            const worker = createWorker({ observability: sink, shardDO: shard.namespace });

            await worker.fetch(
                new Request("https://app.example/_cirrus/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "x:y", shardKey: "tenant-7" }),
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(events[0]!.shardKey).toBe("tenant-7");
        });

        it("reports ok=false when the shard returns a non-2xx", async () => {
            expect.assertions(3);

            const { events, sink } = collectEvents();

            shard.response = new Response("nope", { status: 500 });
            const worker = createWorker({ observability: sink, shardDO: shard.namespace });

            await worker.fetch(
                new Request("https://app.example/_cirrus/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(events[0]!.ok).toBe(false);
            expect(events[0]!.error?.status).toBe(500);
            expect(events[0]!.error?.code).toBe("SHARD_ERROR");
        });

        it("reports ok=false with the thrown error when the fetch throws", async () => {
            expect.assertions(6);

            const { events, sink } = collectEvents();

            shard.throwOnFetch = new Error("connection refused");
            const worker = createWorker({ observability: sink, shardDO: shard.namespace });

            // The outer worker catches throws and maps them via toErrorResponse,
            // so the caller sees a 500 — but the sink must still see the
            // original error captured before the response was built.
            const response = await worker.fetch(
                new Request("https://app.example/_cirrus/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(response.status).toBe(500);
            expect(events[0]!.ok).toBe(false);
            expect(events[0]!.error?.message).toBe("connection refused");
            expect(events[0]!.error?.status).toBe(500);
            expect(events[0]!.error?.code).toBe("INTERNAL_SERVER_ERROR");
            expect(events[0]!.shardKey).toBe("__root__");
        });

        it("reports a structural ConflictError with its real code and status", async () => {
            expect.assertions(2);

            const { events, sink } = collectEvents();

            // Structural ConflictError shape (name/code/status) — mirrors what
            // `@cirrus/do` throws without taking a runtime dependency on it.
            const conflict = Object.assign(new Error("write conflict"), { code: "CONFLICT", name: "ConflictError", status: 409 });

            shard.throwOnFetch = conflict;
            const worker = createWorker({ observability: sink, shardDO: shard.namespace });

            await worker.fetch(
                new Request("https://app.example/_cirrus/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:send" }),
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(events[0]!.error?.code).toBe("CONFLICT");
            expect(events[0]!.error?.status).toBe(409);
        });

        it("emits a fanOut event for cross-shard dispatch", async () => {
            expect.assertions(5);

            const { events, sink } = collectEvents();
            // Use a permissive cast — observability events read only
            // `result.ok` and `result.failed`, so a partial stub is fine.
            const coordinator = {
                fanOut: async () => {
                    return { data: 42, errors: [], failed: 0, ok: 3 };
                },
            } as unknown as QueryCoordinator;
            const worker = createWorker({ observability: sink, queryCoordinator: coordinator, shardDO: shard.namespace });

            const response = await worker.fetch(
                new Request("https://app.example/_cirrus/rpc", {
                    body: JSON.stringify({
                        args: {},
                        fanOut: { merge: { kind: "sum" }, table: "messages" },
                        functionPath: "messages:count",
                    }),
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(response.status).toBe(200);
            expect(events).toHaveLength(1);
            expect(events[0]!.ok).toBe(true);
            expect(events[0]!.fanOut).toEqual({ failed: 0, shards: 3, table: "messages" });
            expect(events[0]!.shardKey).toBeUndefined();
        });

        it("does not fail user dispatch when the sink throws", async () => {
            expect.assertions(1);

            const sink: ObservabilitySink = {
                onRpc: () => {
                    throw new Error("sink down");
                },
            };
            const worker = createWorker({ observability: sink, shardDO: shard.namespace });

            const response = await worker.fetch(
                new Request("https://app.example/_cirrus/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "x:y" }),
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(response.status).toBe(200);
        });
    });
});
