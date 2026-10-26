import { describe, expect, it } from "vitest";

import { decodeIdentityHeader } from "../../../shared/identity-header";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * What the worker puts on the wire when it forwards `/_lunora/rpc` to a shard:
 * the body bytes, the rebind of a relation fan-out's `args.table`, and the
 * origin and identity headers.
 */
const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

interface Forwarded {
    body: string;
    headers: Headers;
    shardKey: string;
}

const recordingShard = (
    respond: (body: string) => Response = () => Response.json({ result: null }),
): { forwarded: Forwarded[]; namespace: ShardNamespaceLike } => {
    const forwarded: Forwarded[] = [];
    const namespace: ShardNamespaceLike = {
        get: (id) => {
            const shardKey = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    const body = await request.text();

                    forwarded.push({ body, headers: request.headers, shardKey });

                    return respond(body);
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return { forwarded, namespace };
};

const rpc = (body: string, url = "https://app.example/_lunora/rpc"): Request => new Request(url, { body, method: "POST" });

describe("rpc forward body", () => {
    it("forwards the caller's envelope text unchanged when it carries only args, functionPath and shardKey", async () => {
        expect.assertions(2);

        const shard = recordingShard();
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: shard.namespace });
        // Key order and whitespace a re-stringify would not reproduce.
        const body = `{ "shardKey": "channel-7", "functionPath": "messages:list", "args": { "limit": 5 } }`;

        await worker.fetch(rpc(body), {}, fakeContext);

        expect(shard.forwarded[0]?.shardKey).toBe("channel-7");
        expect(shard.forwarded[0]?.body).toBe(body);
    });

    it("re-serializes an envelope carrying any other key, so the extra key never reaches the shard", async () => {
        expect.assertions(1);

        const shard = recordingShard();
        const worker = createWorker({ shardDO: shard.namespace });

        await worker.fetch(rpc(JSON.stringify({ args: { limit: 5 }, functionPath: "messages:list", system: true })), {}, fakeContext);

        expect(shard.forwarded[0]?.body).toBe(JSON.stringify({ args: { limit: 5 }, functionPath: "messages:list" }));
    });

    it("binds a relation fan-out's read to the authorized fanOut.table when args.table is absent", async () => {
        expect.assertions(3);

        const shard = recordingShard(() => Response.json([]));
        const worker = createWorker({
            authorizeFanOut: (_identity, table) => table === "posts",
            queryCoordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ posts: ["s1", "s2"] }) }),
            shardDO: shard.namespace,
        });

        const response = await worker.fetch(
            rpc(JSON.stringify({ args: { where: {} }, fanOut: { merge: { kind: "concat" }, table: "posts" }, functionPath: "__lunora_relation__:read" })),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(shard.forwarded.map((entry) => entry.shardKey).toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["s1", "s2"]);
        expect(shard.forwarded.map((entry) => (JSON.parse(entry.body) as { args: { table?: unknown } }).args.table)).toStrictEqual(["posts", "posts"]);
    });
});

describe("rpc forward headers", () => {
    it("stamps the origin the RPC arrived on, port and scheme included", async () => {
        expect.assertions(1);

        const shard = recordingShard();
        const worker = createWorker({ shardDO: shard.namespace });

        await worker.fetch(rpc(JSON.stringify({ args: {}, functionPath: "messages:list" }), "http://localhost:8787/_lunora/rpc"), {}, fakeContext);

        expect(shard.forwarded[0]?.headers.get("x-lunora-origin")).toBe("http://localhost:8787");
    });

    it("encodes each caller's own claims into x-lunora-identity, across repeats and past the memo bound", async () => {
        expect.assertions(1);

        const shard = recordingShard();
        const worker = createWorker({
            resolveIdentity: (request) => {
                const user = request.headers.get("x-test-user") ?? "anon";

                return { name: `name-${user}`, roles: user === "a" ? ["admin"] : ["member"], userId: user };
            },
            shardDO: shard.namespace,
        });

        const sequence = ["a", "b", "a", ...Array.from({ length: 300 }, (_, index) => `u${String(index)}`), "a", "b"];

        for (const user of sequence) {
            // eslint-disable-next-line no-await-in-loop -- sequential on purpose: each request must meet the memo state the previous one left
            await worker.fetch(
                new Request("https://app.example/_lunora/rpc", {
                    body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                    headers: { "x-test-user": user },
                    method: "POST",
                }),
                {},
                fakeContext,
            );
        }

        expect(shard.forwarded.map((entry) => decodeIdentityHeader(entry.headers.get("x-lunora-identity")))).toStrictEqual(
            sequence.map((user) => {
                return { name: `name-${user}`, roles: user === "a" ? ["admin"] : ["member"] };
            }),
        );
    });
});
