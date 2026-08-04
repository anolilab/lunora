import { describe, expect, it } from "vitest";

import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";
import { argsFromQuery } from "../src/rest-routes";

/**
 * The public REST surface (`/_lunora/rest/<namespace>/<fn>`, plan 167) — RUNTIME-02
 * (advisor 226). REST skipped the `args`-shape guard `/_lunora/rpc` enforces via
 * `parseEnvelope`, and `argsFromQuery` assigned into a plain `{}` so a `__proto__`
 * query key could reparent the args object. Both are now the same
 * `assertArgsObject` check / null-proto build the RPC edge and `v.record` use.
 */

interface ShardSpy {
    calls: { request: Request; shardKey: string }[];
    namespace: ShardNamespaceLike;
    response: Response;
}

const createShardSpy = (response = new Response("ok", { status: 200 })): ShardSpy => {
    const calls: { request: Request; shardKey: string }[] = [];
    const spy = { calls, response } as ShardSpy;

    spy.namespace = {
        get: (id) => {
            const shardKey = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    calls.push({ request, shardKey });

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

const fakeContext = { passThroughOnException: () => undefined, waitUntil: () => undefined };

/** A registry with one REST-exposed query and one REST-exposed mutation. */
const restFunctions = {
    "messages:list": { expose: { rest: true }, kind: "query" },
    "messages:send": { expose: { rest: true }, kind: "mutation" },
} as const;

describe("createWorker — REST args-shape boundary", () => {
    it("rejects a POST body of `null` with 400, never forwarding to a shard", async () => {
        expect.assertions(2);

        const shard = createShardSpy();
        const worker = createWorker({ functions: restFunctions, shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rest/messages/send", { body: "null", headers: { "content-type": "application/json" }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
        expect(shard.calls).toHaveLength(0);
    });

    it("rejects a POST body that parses to an array with 400, never forwarding to a shard", async () => {
        expect.assertions(3);

        const shard = createShardSpy();
        const worker = createWorker({ functions: restFunctions, shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rest/messages/send", {
                body: JSON.stringify([1, 2]),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
        expect(shard.calls).toHaveLength(0);
    });

    it("still forwards a well-formed object body", async () => {
        expect.assertions(2);

        const shard = createShardSpy();
        const worker = createWorker({ functions: restFunctions, shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rest/messages/send", {
                body: JSON.stringify({ text: "hi" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(shard.calls).toHaveLength(1);
    });

    it("does not let a `__proto__` query key reparent the forwarded args object", async () => {
        expect.assertions(3);

        const shard = createShardSpy();
        const worker = createWorker({ functions: restFunctions, shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request(`https://app.example/_lunora/rest/messages/list?${encodeURIComponent("__proto__")}=${encodeURIComponent('{"polluted":true}')}`),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(shard.calls).toHaveLength(1);

        const forwardedBody: { args: Record<string, unknown> } = await shard.calls[0]!.request.json();

        // With a plain `{}` accumulator, `args["__proto__"] = …` invokes the
        // inherited setter and REPARENTS `args` instead of creating a data
        // property — `Object.keys`/`JSON.stringify` then see no `__proto__` key
        // at all, and the caller's argument is silently dropped rather than
        // forwarded. With the null-proto accumulator there is no inherited
        // setter to intercept the assignment, so it lands as an ordinary own
        // property and survives the round-trip to the shard.
        expect(Object.getOwnPropertyDescriptor(forwardedBody.args, "__proto__")?.value).toEqual({ polluted: true });
    });
});

describe("argsFromQuery", () => {
    it("builds a null-prototype accumulator, matching v.record", () => {
        expect.assertions(1);

        const args = argsFromQuery(new URL("https://app.example/x?a=1"));

        expect(Object.getPrototypeOf(args)).toBeNull();
    });

    it("stores a `__proto__` query key as an own property rather than reparenting the object", () => {
        expect.assertions(2);

        const args = argsFromQuery(new URL(`https://app.example/x?${encodeURIComponent("__proto__")}=${encodeURIComponent('{"x":1}')}`));

        expect(Object.getPrototypeOf(args)).toBeNull();
        expect(Object.getOwnPropertyDescriptor(args, "__proto__")?.value).toEqual({ x: 1 });
    });

    it("excludes the reserved shardKey key", () => {
        expect.assertions(1);

        const args = argsFromQuery(new URL("https://app.example/x?shardKey=team-1&limit=5"));

        expect(args).toEqual({ limit: 5 });
    });
});
