import { describe, expect, it } from "vitest";

import type { ExecutionContextLike, WorkerOptions } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * The shard learns which origin an RPC arrived on, so `ctx.storage` can sign
 * object URLs against it when the app configured no `publicBaseUrl`. The value
 * must come off the request URL — the host the worker was actually reached on —
 * and never off a header the caller wrote.
 */
const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const functions: WorkerOptions["functions"] = {
    "files:sign": { kind: "action" },
};

const recordingShard = (): { calls: Request[]; namespace: ShardNamespaceLike } => {
    const calls: Request[] = [];
    const namespace: ShardNamespaceLike = {
        get: () => {
            return {
                fetch: async (request: Request) => {
                    calls.push(request);

                    return Response.json({ result: null });
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return { calls, namespace };
};

describe("request origin forwarding", () => {
    it("forwards the origin the RPC reached the worker on", async () => {
        expect.assertions(1);

        const shard = recordingShard();
        const worker = createWorker({ functions, shardDO: shard.namespace });

        await worker.fetch(
            new Request("https://chat.example.com/_lunora/rpc", { body: JSON.stringify({ args: {}, functionPath: "files:sign" }), method: "POST" }),
            {},
            fakeContext,
        );

        expect(shard.calls[0]?.headers.get("x-lunora-origin")).toBe("https://chat.example.com");
    });

    it("ignores an origin the caller wrote into the header", async () => {
        expect.assertions(1);

        const shard = recordingShard();
        const worker = createWorker({ functions, shardDO: shard.namespace });

        await worker.fetch(
            new Request("https://chat.example.com/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "files:sign" }),
                headers: { "x-lunora-origin": "https://attacker.example" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shard.calls[0]?.headers.get("x-lunora-origin")).toBe("https://chat.example.com");
    });
});
