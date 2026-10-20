import { ShardDO } from "@lunora/do";
import { createSocketHost } from "@lunora/platform-cloudflare";
import { createWorker } from "@lunora/runtime";
import { describe, expect, it, vi } from "vitest";

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

    it("keeps a quiet live stream alive with the same keepalive comment the client's idle watchdog counts on", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        try {
            await withShardDo(async (shardDo) => {
                const response = await shardDo.fetch(new Request("http://shard.test/_lunora/live/connect"));
                const reader = response.body?.getReader();
                const decoder = new TextDecoder();

                // The stream's first chunk flushes the headers; nothing is published after it.
                const opening = await reader?.read();

                expect(opening?.value).toStrictEqual(new TextEncoder().encode(":ok\n\n"));

                // The client treats 75s of silence as a dead connection; the host must speak well inside that.
                const quiet = reader?.read();

                await vi.advanceTimersByTimeAsync(25_000);

                const chunk = await quiet;

                expect(decoder.decode(chunk?.value)).toBe(":ka\n\n");

                await vi.advanceTimersByTimeAsync(25_000);

                const second = await reader?.read();

                expect(decoder.decode(second?.value)).toBe(":ka\n\n");

                // The last stream going away stops the timer, so it cannot keep the process alive.
                await reader?.cancel();
                await vi.advanceTimersByTimeAsync(25_000);

                expect(vi.getTimerCount()).toBe(0);
            });
        } finally {
            vi.useRealTimers();
        }
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
                    await live.publish({ __lunoraLive: "orders", topic: "orders" }, { id: 1 }, { shardKey: "tenant-42" });
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
