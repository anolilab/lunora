import { ShardDO } from "@lunora/do";
import { createSocketHost } from "@lunora/platform-cloudflare";
import { describe, expect, it } from "vitest";

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
