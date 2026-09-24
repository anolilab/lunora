import { describe, expect, it } from "vitest";

import type { ExecutionContextLike, HttpRouterLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const shardNamespace = (): ShardNamespaceLike => {
    return {
        get: () => {
            return { fetch: async () => Response.json({ result: null }) };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

describe("createWorker — the reserved `/_lunora/*` plane", () => {
    it("refuses to construct a worker whose `routes` shadow the reserved prefix", () => {
        expect.assertions(1);

        expect(() =>
            createWorker({
                routes: { "/_lunora/admin/functions": () => new Response("shadowed") },
                shardDO: shardNamespace(),
            }),
        ).toThrow(/reserved/i);
    });

    it('refuses a reserved route key in the "METHOD path" form too', () => {
        expect.assertions(1);

        expect(() =>
            createWorker({
                routes: { "POST /_lunora/migrate": () => new Response("shadowed") },
                shardDO: shardNamespace(),
            }),
        ).toThrow(/reserved/i);
    });

    it("still accepts an app route outside the reserved prefix", () => {
        expect.assertions(1);

        expect(() => createWorker({ routes: { "/webhooks/stripe": () => new Response("ok") }, shardDO: shardNamespace() })).not.toThrow();
    });

    it("404s an unmatched reserved path instead of handing it to the app's httpRouter", async () => {
        expect.assertions(4);

        const seen: string[] = [];
        const httpRouter: HttpRouterLike = {
            fetch: (request: Request) => {
                seen.push(new URL(request.url).pathname);

                return new Response("ssr");
            },
        };

        const worker = createWorker({ httpRouter, shardDO: shardNamespace() });

        // A trailing slash and a percent-encoded segment are two ways to miss the
        // exact-path table; neither may reach an app route.
        const slashed = await worker.fetch(new Request("https://app.test/_lunora/rpc/", { body: "{}", method: "POST" }), {}, fakeContext);
        const encoded = await worker.fetch(new Request("https://app.test/_lunora/%61dmin/functions"), {}, fakeContext);

        expect(slashed.status).toBe(404);
        expect(encoded.status).toBe(404);
        expect(seen).toStrictEqual([]);

        // App paths are untouched.
        const app = await worker.fetch(new Request("https://app.test/about"), {}, fakeContext);

        expect(app.status).toBe(200);
    });
});
