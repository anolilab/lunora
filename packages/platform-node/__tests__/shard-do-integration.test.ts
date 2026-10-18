import { ShardDO } from "@lunora/do";
import { createSocketHost } from "@lunora/platform-cloudflare";
import { createWorker } from "@lunora/runtime";
import { describe, expect, it } from "vitest";

import { createNodeShardNamespace } from "../src/node-shard-namespace";
import { createNodeShardRegistry } from "../src/node-shard-registry";
import { createNodeShardState } from "../src/node-shard-state";

/**
 * The one test that puts the real `ShardDO` on a Node-backed shard.
 *
 * Everything else in this package proves a *layer*: the TCK proves the host
 * primitives, `engine-conformance` proves the engine, `shard-state` proves the
 * two Cloudflare adapters accept a Node state. Nothing proved the class that
 * actually serves a request, and the repo has four separate SQLite-on-Node
 * implementations that "mirror" `ShardDO` without being it — so every suite
 * could agree with itself while the real path was broken.
 *
 * It was: `createNodeShardState.acceptWebSocket` discarded the handle and the
 * attachment, so a socket carried no subscriptions, no identity and no admin
 * flag, and every read returned `undefined` behind an optional-chain guard.
 * Green everywhere. This file exists so that class of failure has somewhere to
 * be caught.
 */

/**
 * `ShardDO` is abstract with exactly one member — `handleRpc`, the function
 * dispatch table codegen emits per app. Stubbing it is all a test needs to get
 * a real, constructible shard, which is a far lower wall than "you need a
 * generated app" implied.
 */
class TestShardDO extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- a dispatch stub has no instance state to reach for; the real subclass codegen emits does
    public handleRpc(functionPath: string): Promise<unknown> {
        return Promise.resolve({ functionPath });
    }
}

describe("shardDO on a Node-backed shard", () => {
    const withShardDo = async <T>(run: (shardDo: TestShardDO, raw: { messages: unknown[] }) => Promise<T> | T): Promise<T> => {
        const registry = createNodeShardRegistry();

        try {
            const state = createNodeShardState(registry.shardFor("tenant-42"));
            const shardDo = new TestShardDO(state as never, {});
            const raw = { messages: [] as unknown[] };

            return await run(shardDo, raw);
        } finally {
            registry.close();
        }
    };

    it("constructs over a Node state without reaching for a Cloudflare primitive", async () => {
        expect.assertions(1);

        await withShardDo((shardDo) => {
            // Construction alone is load-bearing: `ShardDO`'s constructor calls
            // `createShardHost(state)` and `createSocketHost(state)` eagerly, so
            // a state missing something they touch fails here rather than on the
            // first request.
            expect(shardDo).toBeInstanceOf(ShardDO);
        });
    });

    it("round-trips a socket attachment through accept and enumeration", async () => {
        expect.assertions(2);

        await withShardDo((shardDo) => {
            const { state } = shardDo as unknown as { state: ReturnType<typeof createNodeShardState> };
            const socket = { close: () => undefined, send: () => undefined };
            const attachment = { admin: false, connectionId: "c-1", subs: {} };

            // Through `createSocketHost`, which is what `ShardDO`'s constructor
            // builds and what its upgrade path calls — not `state.acceptWebSocket`
            // directly. The adapter stamps the attachment onto the socket it
            // returns and hands that back as the handle; `ShardDO` then reads it
            // on every frame to find the socket's subscriptions and identity.
            const sockets = createSocketHost(state as never);

            sockets.accept(socket, attachment, ["room-a"]);

            const listed: { deserializeAttachment?: () => unknown }[] = sockets.getSockets();

            expect(listed).toHaveLength(1);
            // Asserting the payload, not the count: a host that accepts the
            // socket and drops the attachment passes a length check and serves
            // no subscriptions at all.
            expect(listed[0]?.deserializeAttachment?.()).toStrictEqual(attachment);
        });
    });
});

const SECRET = "hunter2-the-real-secret";

/**
 * The same `ShardDO` the Cloudflare host runs, with one argument `value` marked as
 * `v.sensitive` by the function registry the generated subclass would consult.
 */
class SensitiveNodeShardDO extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- a dispatch stub has no instance state to reach for
    public override handleRpc(functionPath: string, args: Record<string, unknown> = {}): Promise<unknown> {
        return Promise.resolve({ functionPath, label: args["label"] });
    }

    // eslint-disable-next-line class-methods-use-this -- test double: the marked names are fixed per path
    protected override sensitiveArgNames(functionPath: string): ReadonlySet<string> {
        return functionPath.startsWith("vault:") ? new Set(["value"]) : new Set();
    }
}

describe("a v.sensitive argument on a Node-backed shard", () => {
    it("masks the marked value in the request log row of a shard that targets node", async () => {
        expect.assertions(3);

        const registry = createNodeShardRegistry();

        try {
            const state = createNodeShardState(registry.shardFor("tenant-42"));
            const shardDo = new SensitiveNodeShardDO(state as never, {});

            const response = await shardDo.fetch(
                new Request("https://shard.internal/rpc", {
                    body: JSON.stringify({ args: { label: "primary", value: SECRET }, functionPath: "vault:store" }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );

            const rows = (state.storage.sql as unknown as { exec: (query: string) => { toArray: () => { args: string | null }[] } })
                .exec("SELECT args FROM __lunora_reqlog__")
                .toArray();

            expect(response.status).toBe(200);
            expect(rows).toHaveLength(1);
            expect(JSON.stringify(rows)).not.toContain(SECRET);
        } finally {
            registry.close();
        }
    });
});

describe("queue consumer on a Node-backed worker", () => {
    it("hands the consumer the live publisher and the host fetch, and the publish reaches the named shard", async () => {
        expect.assertions(3);

        const shardDos = new Map<string, TestShardDO>();
        const publishedTo: string[] = [];
        // The registry's `onFetch` is the per-shard request handler: each resolved
        // shard is served by one real ShardDO, as the embedder composes it.
        const registry = createNodeShardRegistry({
            onFetch: (request, shard) => {
                if (new URL(request.url).pathname === "/_lunora/live/publish") {
                    publishedTo.push(shard.shardKey);
                }

                let shardDo = shardDos.get(shard.shardKey);

                if (shardDo === undefined) {
                    shardDo = new TestShardDO(createNodeShardState(shard) as never, {});
                    shardDos.set(shard.shardKey, shardDo);
                }

                return shardDo.fetch(request);
            },
        });

        try {
            const hostFetch = (() => Promise.resolve(new Response("ran"))) as typeof fetch;
            let consumerFetch: typeof fetch | undefined;
            const worker = createWorker({
                queue: async (_batch, _env, _context, _trigger, live, fetchImpl) => {
                    consumerFetch = fetchImpl;
                    await live.publish("orders", { id: 1 }, { shardKey: "tenant-42", stream: "orders" });
                },
                queueFetchImpl: hostFetch,
                shardDO: createNodeShardNamespace(registry.directory),
            });
            const context = { passThroughOnException: () => undefined, waitUntil: () => undefined };

            const { queue } = worker;

            if (queue === undefined) {
                throw new Error("createWorker returned no queue export");
            }

            await queue({ messages: [], queue: "orders" }, {}, context);

            // ctx.live reached the shard the publish named, through the same
            // ShardDO route an HTTP action's publish takes.
            expect(publishedTo).toStrictEqual(["tenant-42"]);
            // ctx.run's dispatcher is the host's fetch, not the global one.
            expect(consumerFetch).toBe(hostFetch);
            expect(shardDos.has("tenant-42")).toBe(true);
        } finally {
            registry.close();
        }
    });
});
