import { LunoraError } from "@lunora/errors";
import { beforeEach, describe, expect, it } from "vitest";

import { describeInternal } from "../../../shared/error-detail";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { LogEvent, ObservabilityEvent, ObservabilitySink } from "../src/observability";
import { emitLogEvent, emitRpcEvent } from "../src/observability";
import type { QueryCoordinator } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

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

    describe("emitLogEvent", () => {
        const logEvent: LogEvent = { args: ["hi"], functionPath: "messages:list", level: "info", message: "hi", ts: 1 };

        it("no-ops when the sink or onLog is missing", () => {
            expect.assertions(2);

            expect(() => {
                emitLogEvent(undefined, logEvent);
            }).not.toThrow();
            expect(() => {
                emitLogEvent({}, logEvent);
            }).not.toThrow();
        });

        it("swallows a throwing onLog callback", () => {
            expect.assertions(1);

            const sink: ObservabilitySink = {
                onLog: () => {
                    throw new Error("log sink exploded");
                },
            };

            expect(() => {
                emitLogEvent(sink, logEvent);
            }).not.toThrow();
        });

        it("forwards the event when onLog is set", () => {
            expect.assertions(1);

            const seen: LogEvent[] = [];

            emitLogEvent(
                {
                    onLog: (event) => {
                        seen.push(event);
                    },
                },
                logEvent,
            );

            expect(seen).toEqual([logEvent]);
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
                new Request("https://app.example/_lunora/rpc", {
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
            const worker = createWorker({ allowUnauthenticatedShardAccess: true, observability: sink, shardDO: shard.namespace });

            await worker.fetch(
                new Request("https://app.example/_lunora/rpc", {
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
                new Request("https://app.example/_lunora/rpc", {
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

        it("reports the shard's own error detail (stack included) and keeps it from the client", async () => {
            expect.assertions(4);

            const { events, sink } = collectEvents();
            const detail = {
                code: "INTERNAL_SERVER_ERROR",
                message: "db down",
                name: "TypeError",
                stack: "TypeError: db down\n    at handler (messages.ts:3:9)",
            };
            let asked: null | string = null;

            const namespace: ShardNamespaceLike = {
                get: () => {
                    return {
                        fetch: async (request: Request) => {
                            asked = request.headers.get("x-lunora-want-error-detail");

                            return Response.json(
                                { error: { code: "INTERNAL_SERVER_ERROR", message: "internal error" } },
                                { headers: { "x-lunora-error-detail": encodeURIComponent(JSON.stringify(detail)) }, status: 500 },
                            );
                        },
                    };
                },
                idFromName: (name) => {
                    return { __name: name };
                },
            };
            const worker = createWorker({ observability: sink, shardDO: namespace });

            const response = await worker.fetch(
                new Request("https://app.example/_lunora/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(asked).toBe("1");
            expect(events[0]!.error).toStrictEqual({ ...detail, status: 500 });
            expect(response.headers.get("x-lunora-error-detail")).toBeNull();
            await expect(response.text()).resolves.not.toContain("stack");
        });

        it("carries a LunoraError's operator context when the shard call throws before any response", async () => {
            expect.assertions(1);

            const events: ObservabilityEvent[] = [];
            const sink: ObservabilitySink = {
                onRpc: (event) => {
                    events.push(event);
                },
            };
            const namespace: ShardNamespaceLike = {
                get: () => {
                    return {
                        fetch: async () => {
                            throw new LunoraError("CONFLICT", "stale", { internal: { shardId: "shard-42" } });
                        },
                    };
                },
                idFromName: (name) => {
                    return { __name: name };
                },
            };
            const worker = createWorker({ observability: sink, shardDO: namespace });

            await worker.fetch(
                new Request("https://app.example/_lunora/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "orders:place" }),
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(events[0]?.error?.internal).toStrictEqual({ shardId: "shard-42" });
        });

        it("keeps an operator context larger than the header cap when the failure never crossed a header", async () => {
            expect.assertions(1);

            const events: ObservabilityEvent[] = [];
            const sink: ObservabilitySink = {
                onRpc: (event) => {
                    events.push(event);
                },
            };
            const large = "x".repeat(20_000);
            const namespace: ShardNamespaceLike = {
                get: () => {
                    return {
                        fetch: async () => {
                            throw new LunoraError("CONFLICT", "stale", { internal: { blob: large } });
                        },
                    };
                },
                idFromName: (name) => {
                    return { __name: name };
                },
            };
            const worker = createWorker({ observability: sink, shardDO: namespace });

            await worker.fetch(
                new Request("https://app.example/_lunora/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "orders:place" }),
                    method: "POST",
                }),
                {},
                fakeContext,
            );

            expect(events[0]?.error?.internal).toMatchObject({ blob: expect.stringMatching(/^x+/u) });
        });

        it("forwards the shard's internal context to the sink, redacted, and never to the client", async () => {
            expect.assertions(5);

            const SENTINEL = "INTERNAL_CONTEXT_SENTINEL_7f3a";
            const { events, sink } = collectEvents();
            const detail = {
                code: "CONFLICT",
                internal: { password: `${SENTINEL}-pw`, region: SENTINEL },
                message: "stale",
                name: "LunoraError",
            };
            const namespace: ShardNamespaceLike = {
                get: () => {
                    return {
                        fetch: async () =>
                            Response.json(
                                { error: { code: "CONFLICT", message: "stale" } },
                                { headers: { "x-lunora-error-detail": encodeURIComponent(JSON.stringify(detail)) }, status: 409 },
                            ),
                    };
                },
                idFromName: (name) => {
                    return { __name: name };
                },
            };
            const worker = createWorker({ observability: sink, shardDO: namespace });

            const response = await worker.fetch(
                new Request("https://app.example/_lunora/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:send" }),
                    method: "POST",
                }),
                {},
                fakeContext,
            );
            const sinkInternal = events[0]!.error?.internal;

            // The sink gets the context, with the credential-named field masked.
            expect(sinkInternal).toMatchObject({ region: SENTINEL });
            expect(sinkInternal?.password).not.toBe(`${SENTINEL}-pw`);
            // The client gets neither the header nor the value in the body.
            expect(response.headers.get("x-lunora-error-detail")).toBeNull();
            expect(JSON.stringify([...response.headers])).not.toContain(SENTINEL);
            await expect(response.text()).resolves.not.toContain(SENTINEL);
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
                new Request("https://app.example/_lunora/rpc", {
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
            // `@lunora/do` throws without taking a runtime dependency on it.
            const conflict = new LunoraError("CONFLICT", "write conflict", { name: "ConflictError", status: 409 });

            shard.throwOnFetch = conflict;
            const worker = createWorker({ observability: sink, shardDO: shard.namespace });

            await worker.fetch(
                new Request("https://app.example/_lunora/rpc", {
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
            const worker = createWorker({
                allowUnauthenticatedShardAccess: true,
                observability: sink,
                queryCoordinator: coordinator,
                shardDO: shard.namespace,
            });

            const response = await worker.fetch(
                new Request("https://app.example/_lunora/rpc", {
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
                new Request("https://app.example/_lunora/rpc", {
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

describe("observabilitySink: error.internal reaches sinks, redacted", () => {
    it("hands a sink the internal context with secret-shaped values masked", () => {
        expect.assertions(3);

        const { events, sink } = collectEvents();

        emitRpcEvent(sink, {
            durationMs: 1,
            error: { code: "INTERNAL", internal: { password: "not-a-real-credential", region: "eu-west-replica" }, message: "boom", status: 500 }, // gitleaks:allow -- test fixture, not a credential
            functionPath: "orders:place",
            ok: false,
        });

        expect(events).toHaveLength(1);
        // A plain operator value passes through untouched...
        expect(events[0]?.error?.internal).toMatchObject({ region: "eu-west-replica" });
        // ...and a credential-named field is masked before the sink sees it.
        expect(events[0]?.error?.internal?.password).not.toBe("not-a-real-credential"); // gitleaks:allow -- test fixture, not a credential
    });

    it("keeps ids and URLs in the operator context, which the PII rules would mask", () => {
        expect.assertions(1);

        const { events, sink } = collectEvents();

        emitRpcEvent(sink, {
            durationMs: 1,
            error: { code: "INTERNAL", internal: { shardId: "shard-42", upstream: "https://replica.example/v1" }, message: "boom", status: 500 },
            functionPath: "orders:place",
            ok: false,
        });

        expect(events[0]?.error?.internal).toEqual({ shardId: "shard-42", upstream: "https://replica.example/v1" });
    });

    it("masks a credential inside a nested Error, which the key-aware redactor would pass through", () => {
        expect.assertions(1);

        const { events, sink } = collectEvents();
        const upstream = Object.assign(new Error("upstream refused"), { password: "hunter2-secret" }); // gitleaks:allow -- test fixture, not a credential

        emitRpcEvent(sink, {
            durationMs: 1,
            error: { code: "INTERNAL", internal: { upstream }, message: "boom", status: 500 },
            functionPath: "orders:place",
            ok: false,
        });

        expect(JSON.stringify(events[0]?.error?.internal)).not.toContain("hunter2-secret");
    });

    it("masks a credential in a nested Error's message as the sink receives it", () => {
        expect.assertions(1);

        const { events, sink } = collectEvents();

        emitRpcEvent(sink, {
            durationMs: 1,
            error: { code: "INTERNAL", internal: { upstream: new Error("password=hunter2-secret") }, message: "boom", status: 500 }, // gitleaks:allow -- test fixture, not a credential
            functionPath: "orders:place",
            ok: false,
        });

        // Read the property the sink receives: an Error's message is not JSON-enumerable.
        const upstream = events[0]?.error?.internal?.upstream as { message?: unknown } | undefined;

        expect(upstream?.message).toBe("password=<REDACTED>");
    });

    it("keeps a nested Error's message from the shard's detail header through to the sink", () => {
        expect.assertions(1);

        const { events, sink } = collectEvents();
        const error = new LunoraError("CONFLICT", "stale", { internal: { upstream: new Error("upstream refused") } });

        emitRpcEvent(sink, {
            durationMs: 1,
            error: { code: "CONFLICT", internal: describeInternal(error), message: "stale", status: 409 },
            functionPath: "orders:place",
            ok: false,
        });

        expect((events[0]?.error?.internal?.upstream as { message?: unknown } | undefined)?.message).toBe("upstream refused");
    });

    it("drops an operator context whose toJSON serializes to a primitive", () => {
        expect.assertions(1);

        const error = new LunoraError("CONFLICT", "stale", { internal: { toJSON: () => null } });

        expect(describeInternal(error)).toBeUndefined();
    });

    it("still delivers the event when a getter in the operator context throws", () => {
        expect.assertions(2);

        const { events, sink } = collectEvents();

        emitRpcEvent(sink, {
            durationMs: 1,
            error: {
                code: "INTERNAL",
                internal: {
                    get boom(): never {
                        throw new Error("getter exploded");
                    },
                },
                message: "boom",
                status: 500,
            },
            functionPath: "orders:place",
            ok: false,
        });

        expect(events).toHaveLength(1);
        expect(events[0]?.error?.internal).toBeUndefined();
    });

    it("leaves an event without internal untouched", () => {
        expect.assertions(1);

        const { events, sink } = collectEvents();
        const event: ObservabilityEvent = { durationMs: 1, error: { code: "CONFLICT", message: "stale", status: 409 }, functionPath: "x:y", ok: false };

        emitRpcEvent(sink, event);

        expect(events[0]).toBe(event);
    });
});
