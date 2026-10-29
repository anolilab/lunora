import { describe, expect, it, vi } from "vitest";

import { signCanonical } from "../../../shared/hmac-url";
import type { NodeDispatchInvocation } from "../src/node-dispatch-route";
import { createNodeDispatchRoute, createShardInvoke, NODE_SCHEDULER_DISPATCH_PATH } from "../src/node-dispatch-route";

const TOKEN = "admin-token-for-tests";
const SECRET = "scheduler-secret-for-tests";

const build = (invoke = vi.fn<(call: NodeDispatchInvocation) => Promise<Response>>(async () => Response.json({ ok: true }))) => {
    return {
        invoke,
        route: createNodeDispatchRoute({ adminToken: TOKEN, defaultShardKey: "__root__", invoke, schedulerSecret: SECRET }),
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
        expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ args: { n: 1 }, functionPath: "notes:add", id: "job-1", shardKey: "tenant-a" }));
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

    it("accepts an HMAC over the exact body when the scheduler secret is set", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const signature = await signCanonical(SECRET, payload);
        const response = await route(post(payload, { "x-lunora-scheduler-signature": signature }));

        expect(response.status).toBe(200);
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("refuses a signature computed over a different body", async () => {
        expect.assertions(2);

        const { invoke, route } = build();
        const signature = await signCanonical(SECRET, '{"functionPath":"other:fn"}');
        const response = await route(post(payload, { "x-lunora-scheduler-signature": signature }));

        expect(response.status).toBe(403);
        expect(invoke).not.toHaveBeenCalled();
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

        await invoke({ args: { n: 1 }, functionPath: "notes:add", id: "job-9", identity: undefined, shardKey: "tenant-a", traceparent: undefined });

        const [request] = fetch.mock.calls[0] as unknown as [Request];

        expect(request.headers.get("x-lunora-system")).toBe("1");
        expect(request.headers.get("x-lunora-paywall")).toBe("1");
        expect(request.headers.get("x-lunora-mutation-id")).toBe("job-9");
        await expect(request.json()).resolves.toStrictEqual({ args: { n: 1 }, functionPath: "notes:add" });
    });
});
