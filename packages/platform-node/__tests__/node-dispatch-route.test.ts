import { describe, expect, it, vi } from "vitest";

import { SCHEDULER_SIGNATURE_TOLERANCE_MS, signSchedulerDispatch } from "../../../shared/scheduler-dispatch";
import type { NodeDispatchInvocation } from "../src/node-dispatch-route";
import { createNodeDispatchRoute, createShardInvoke, NODE_SCHEDULER_DISPATCH_PATH } from "../src/node-dispatch-route";

const TOKEN = "admin-token-for-tests";
const SECRET = "scheduler-secret-for-tests";
const NOW = 1_700_000_000_000;

// SHA-256 vectors, computed outside the code under test (`shared/scheduled-mutation-id.ts`).
const USER_1_SCOPE = "c6c289e49e9c05b2145860387b73bcb1";
const JOB_1_MUTATION_ID = "4d377f7886b7213f2ded06a3aaf991a6ac49896e017ed55c126ea07ff5fe9221";
const SYNC_MUTATION_ID = "b80091bfc07dfe767ed4bb13b1867abec8b48b3974cacd29773468eaab6b4ea3";
const SYNC_USER_1_MUTATION_ID = "e026610c1c20b5a37102fc06f76d7251d7d48c3f16ef46c646a793116e4c4a25";
const DELIVERY_1_MUTATION_ID = "0693d7dd81495de5ad93cfe3ea75c24ab9dc579f59892fce9abbf68e43aa2ca6";

const build = (invoke = vi.fn<(call: NodeDispatchInvocation) => Promise<Response>>(async () => Response.json({ ok: true }))) => {
    return {
        invoke,
        route: createNodeDispatchRoute({ adminToken: TOKEN, defaultShardKey: "__root__", invoke, now: () => NOW, schedulerSecret: SECRET }),
    };
};

const post = (body: string, headers: Record<string, string> = {}): Request =>
    new Request(`https://node.local${NODE_SCHEDULER_DISPATCH_PATH}`, {
        body,
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
    });

const payload = JSON.stringify({ args: { n: 1 }, functionPath: "notes:add", id: "job-1", shardKey: "tenant-a" });

describe("createNodeDispatchRoute", () => {
    it("runs the call with the wire values when the admin bearer matches", async () => {
        expect.assertions(3);

        const { invoke, route } = build();
        const response = await route(post(payload, { authorization: `Bearer ${TOKEN}` }));

        expect(response.status).toBe(200);
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith(
            expect.objectContaining({ args: { n: 1 }, functionPath: "notes:add", id: JOB_1_MUTATION_ID, shardKey: "tenant-a" }),
        );
    });

    it("carries the job's due time from the body through to the shard headers", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const body = JSON.stringify({ args: {}, functionPath: "notes:add", id: "job-2", scheduledFor: 1_700_000_000_000 });

        await route(post(body, { authorization: `Bearer ${TOKEN}` }));

        const [call] = invoke.mock.calls[0] as [NodeDispatchInvocation];
        const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => Response.json({ result: null }));

        await createShardInvoke(
            {
                getByName: () => {
                    return { fetch };
                },
            },
            true,
        )(call);

        const [request] = fetch.mock.calls[0] as unknown as [Request];

        expect(call.scheduledFor).toBe(1_700_000_000_000);
        expect(request.headers.get("x-lunora-scheduled-for")).toBe("1700000000000");
    });

    it("derives the shard's mutation id from the function, the scheduling user's scope and the dedupKey, falling back to the id", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const keyed = JSON.stringify({ args: {}, dedupKey: "sync-user-1700000000000", functionPath: "notes:add", id: "sync-user" });
        const scoped = JSON.stringify({ args: {}, dedupKey: "sync-user-1700000000000", dedupScope: USER_1_SCOPE, functionPath: "notes:add", id: "sync-user" });
        const bare = JSON.stringify({ args: {}, functionPath: "notes:add", id: "delivery-1" });

        await route(post(keyed, { authorization: `Bearer ${TOKEN}` }));
        await route(post(scoped, { authorization: `Bearer ${TOKEN}` }));
        await route(post(bare, { authorization: `Bearer ${TOKEN}` }));

        const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => Response.json({ result: null }));
        const shardInvoke = createShardInvoke(
            {
                getByName: () => {
                    return { fetch };
                },
            },
            true,
        );

        await Promise.all(invoke.mock.calls.map(async ([call]) => shardInvoke(call)));

        // The same vectors the Workers route is held to in `@lunora/runtime`'s scheduled-workpool test.
        // A sender without a key (a queue delivery) derives from its own id.
        expect(fetch.mock.calls.map(([request]) => request.headers.get("x-lunora-mutation-id"))).toStrictEqual([
            SYNC_MUTATION_ID,
            SYNC_USER_1_MUTATION_ID,
            DELIVERY_1_MUTATION_ID,
        ]);
        expect(invoke).toHaveBeenCalledTimes(3);
    });

    it("refuses a dedupScope the SchedulerDO would not have written with 400 INVALID_INPUT and never invokes", async () => {
        expect.assertions(3);

        const { invoke, route } = build();
        const response = await route(
            post(JSON.stringify({ args: {}, dedupKey: "k", dedupScope: "user-1", functionPath: "notes:add", id: "job-1" }), {
                authorization: `Bearer ${TOKEN}`,
            }),
        );
        const body = (await response.json()) as { error: { code: string } };

        expect(response.status).toBe(400);
        expect(body.error.code).toBe("INVALID_INPUT");
        expect(invoke).not.toHaveBeenCalled();
    });

    it("refuses a dedupKey the SchedulerDO would not have written with 400 INVALID_INPUT and never invokes", async () => {
        expect.assertions(3);

        const { invoke, route } = build();
        // A newline is header-illegal: spent as the mutation id it made the shard forward's `new Request` throw a 500.
        const response = await route(
            post(JSON.stringify({ args: {}, dedupKey: "bad\nkey", functionPath: "notes:add", id: "job-1" }), { authorization: `Bearer ${TOKEN}` }),
        );
        const body = (await response.json()) as { error: { code: string } };

        expect(response.status).toBe(400);
        expect(body.error.code).toBe("INVALID_INPUT");
        expect(invoke).not.toHaveBeenCalled();
    });

    it("refuses a wrong bearer with DISPATCH_UNAUTHENTICATED and never invokes", async () => {
        expect.assertions(3);

        const { invoke, route } = build();
        const response = await route(post(payload, { authorization: "Bearer wrong" }));
        const body = (await response.json()) as { error: { code: string } };

        expect(response.status).toBe(403);
        expect(body.error.code).toBe("DISPATCH_UNAUTHENTICATED");
        expect(invoke).not.toHaveBeenCalled();
    });

    it("accepts an HMAC over the exact body and a fresh timestamp when the scheduler secret is set", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const signature = await signSchedulerDispatch(SECRET, { body: payload, timestamp: NOW });
        const response = await route(post(payload, { "x-lunora-scheduler-signature": signature, "x-lunora-scheduler-timestamp": String(NOW) }));

        expect(response.status).toBe(200);
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("refuses a signature computed over a different body", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const signature = await signSchedulerDispatch(SECRET, { body: '{"functionPath":"other:fn"}', timestamp: NOW });
        const response = await route(post(payload, { "x-lunora-scheduler-signature": signature, "x-lunora-scheduler-timestamp": String(NOW) }));

        expect(response.status).toBe(403);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("refuses a signature older than the tolerance", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const stamp = NOW - SCHEDULER_SIGNATURE_TOLERANCE_MS - 1;
        const signature = await signSchedulerDispatch(SECRET, { body: payload, timestamp: stamp });
        const response = await route(post(payload, { "x-lunora-scheduler-signature": signature, "x-lunora-scheduler-timestamp": String(stamp) }));

        expect(response.status).toBe(403);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("refuses a signed request with an identity header the signature did not cover", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const signature = await signSchedulerDispatch(SECRET, { body: payload, timestamp: NOW });
        const response = await route(
            post(payload, {
                "x-lunora-scheduler-signature": signature,
                "x-lunora-scheduler-timestamp": String(NOW),
                "x-lunora-userid": "u2",
            }),
        );

        expect(response.status).toBe(403);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("refuses a signature without a timestamp header", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const signature = await signSchedulerDispatch(SECRET, { body: payload, timestamp: NOW });
        const response = await route(post(payload, { "x-lunora-scheduler-signature": signature }));

        expect(response.status).toBe(403);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("accepts a signature that covers the forwarded identity and forwards it", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const signature = await signSchedulerDispatch(SECRET, { body: payload, timestamp: NOW, userId: "u1" });
        const response = await route(
            post(payload, {
                "x-lunora-scheduler-signature": signature,
                "x-lunora-scheduler-timestamp": String(NOW),
                "x-lunora-userid": "u1",
            }),
        );

        expect(response.status).toBe(200);
        expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ identity: { userId: "u1" } }));
    });

    it("answers 400 BAD_REQUEST when functionPath is missing", async () => {
        expect.assertions(3);

        const { invoke, route } = build();
        const response = await route(post(JSON.stringify({ args: {} }), { authorization: `Bearer ${TOKEN}` }));
        const body = (await response.json()) as { error: { code: string } };

        expect(response.status).toBe(400);
        expect(body.error.code).toBe("BAD_REQUEST");
        expect(invoke).not.toHaveBeenCalled();
    });

    it("answers 405 for a GET", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const response = await route(new Request(`https://node.local${NODE_SCHEDULER_DISPATCH_PATH}`, { headers: { authorization: `Bearer ${TOKEN}` } }));

        expect(response.status).toBe(405);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("passes the invoke response through unchanged, so a 409 decline stays retryable", async () => {
        expect.assertions(2);

        const declined = new Response("busy", { headers: { "x-lunora-dispatch": "DISPATCH_DECLINED" }, status: 409 });
        const { route } = build(vi.fn<() => Promise<Response>>(async () => declined));
        const response = await route(post(payload, { authorization: `Bearer ${TOKEN}` }));

        expect(response.status).toBe(409);
        expect(response.headers.get("x-lunora-dispatch")).toBe("DISPATCH_DECLINED");
    });

    it("fails closed when neither secret is configured", async () => {
        expect.assertions(2);

        const invoke = vi.fn<() => Promise<Response>>(async () => Response.json({ ok: true }));
        const route = createNodeDispatchRoute({ defaultShardKey: "__root__", invoke });
        const response = await route(post(payload, { authorization: `Bearer ${TOKEN}` }));

        expect(response.status).toBe(403);
        expect(invoke).not.toHaveBeenCalled();
    });
});

describe("the dispatch route's refusals and shard headers", () => {
    it("refuses the fan-out-only reserved reader and never invokes", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const response = await route(post(JSON.stringify({ functionPath: "__lunora_relation__:x" }), { authorization: `Bearer ${TOKEN}` }));

        expect(response.status).toBe(403);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("refuses agents:agentRun bound to a non-default shard, and forwards it on the default one", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const agentRun = (shardKey?: string): Request =>
            post(JSON.stringify({ args: { agent: "support", input: "hi", threadKey: "t" }, functionPath: "agents:agentRun", shardKey }), {
                authorization: `Bearer ${TOKEN}`,
            });

        // Its in-flight check reads the agent thread table, which only the default shard holds.
        const refused = await route(agentRun("tenant-a"));

        await route(agentRun());

        expect(refused.status).toBe(400);
        expect(invoke.mock.calls.map(([call]) => call.shardKey)).toStrictEqual(["__root__"]);
    });

    it("answers a workflow target with a retryable 503, not a deterministic 400", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const response = await route(post(JSON.stringify({ functionPath: "x:y", workflow: "wf" }), { authorization: `Bearer ${TOKEN}` }));

        expect(response.status).toBe(503);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("refuses a shard key in the reserved role namespace before reaching any shard", async () => {
        expect.assertions(3);

        // The runtime's `resolveShard` refuses this prefix. Before the route went
        // through it, the call reached the directory and a shard answered it.
        const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => Response.json({ result: null }));
        const getByName = vi.fn<(name: string) => { fetch: (request: Request) => Promise<Response> }>(() => {
            return { fetch };
        });
        const invoke = createShardInvoke({ getByName }, true);
        const route = createNodeDispatchRoute({ adminToken: TOKEN, defaultShardKey: "__root__", invoke });
        const response = await route(
            post(JSON.stringify({ functionPath: "notes:add", shardKey: "__lunora_do__:tenant" }), { authorization: `Bearer ${TOKEN}` }),
        );

        expect(response.status).toBe(400);
        expect(getByName).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("sends the system and paywall markers to the shard with the call's idempotency key", async () => {
        expect.assertions(4);

        const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => Response.json({ result: null }));
        const invoke = createShardInvoke(
            {
                getByName: () => {
                    return { fetch };
                },
            },
            true,
        );

        await invoke({
            args: { n: 1 },
            functionPath: "notes:add",
            id: "job-9",
            identity: undefined,
            shardKey: "tenant-a",
            traceparent: undefined,
        });

        const [request] = fetch.mock.calls[0] as unknown as [Request];

        expect(request.headers.get("x-lunora-system")).toBe("1");
        expect(request.headers.get("x-lunora-paywall")).toBe("1");
        expect(request.headers.get("x-lunora-mutation-id")).toBe("job-9");
        await expect(request.json()).resolves.toStrictEqual({ args: { n: 1 }, functionPath: "notes:add" });
    });
});
