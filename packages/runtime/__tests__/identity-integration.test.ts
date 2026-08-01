/**
 * Integration-shaped regression test for the ByteString identity-header bug
 * (plan 213): a `resolveIdentity` returning non-Latin-1 claims used to make
 * `new Request(...)` throw a `TypeError` before the shard was ever reached,
 * turning into an opaque INTERNAL 500 for every RPC.
 *
 * Unlike the rest of `@lunora/runtime`'s worker suite — which passes a
 * hand-rolled `ShardNamespaceLike` double that never constructs a real
 * `Request` — this drives a REAL `ShardDO` instance (from `@lunora/do`)
 * through a REAL `createWorker(...)`, so the encode (runtime) and decode (DO)
 * halves of the fix are exercised together across the actual package
 * boundary, with a genuine `new Request(...)` in between (see
 * `admin-roundtrip.test.ts` for the precedent of a runtime test driving a
 * real `ShardDO`). Node's `fetch`/`Request`/`Headers` (undici) enforce the
 * same WebIDL `ByteString` constraint workerd does, so this reproduces the
 * exact failure mode without needing the gated `LUNORA_WORKERD_TESTS=1` suite
 * (`packages/runtime/__tests__/workerd/`, which has no identity-specific test
 * to extend today — noted here rather than standing up new workerd infra for
 * this one case, per plan 213).
 */
import type { ShardDOState } from "@lunora/do";
import { ShardDO } from "@lunora/do";
import { describe, expect, it } from "vitest";

import type { ExecutionContextLike, ResolvedIdentity } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/** A `ShardDO` whose `handleRpc` bypasses all storage and just echoes back what `ctx.auth` sees. */
class IdentityEchoShard extends ShardDO {
    public override async handleRpc(): Promise<unknown> {
        return { identity: this.getCurrentIdentity(), userId: this.getCurrentUserId() };
    }
}

const createRealShardNamespace = (): ShardNamespaceLike => {
    const state: ShardDOState = {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        // `handleRpc` never touches storage, so a real SQLite backing isn't needed —
        // mirrors `shard-do.test.ts`'s `createFakeState`.
        storage: { sql: undefined as never },
    };
    const shard = new IdentityEchoShard(state, {});

    return {
        get: () => {
            return { fetch: (request: Request) => shard.fetch(request) };
        },
        idFromName: (name) => name,
    };
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

describe("identity header integration (worker -> real ShardDO)", () => {
    it("dispatches a CJK + emoji identity end-to-end and ctx.auth sees it intact", async () => {
        expect.assertions(3);

        const worker = createWorker({
            resolveIdentity: (): ResolvedIdentity => {
                return { name: "名前 🎌", userId: "user_42" };
            },
            shardDO: createRealShardNamespace(),
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { result: { identity: Record<string, unknown>; userId: string } } = await response.json();

        expect(body.result.userId).toBe("user_42");
        expect(body.result.identity).toStrictEqual({ name: "名前 🎌" });
    });

    it("dispatches a non-Latin-1 userId end-to-end and ctx.auth sees it intact", async () => {
        expect.assertions(2);

        const worker = createWorker({
            resolveIdentity: (): ResolvedIdentity => {
                return { userId: "田中太郎" };
            },
            shardDO: createRealShardNamespace(),
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { result: { userId: string } } = await response.json();

        expect(body.result.userId).toBe("田中太郎");
    });
});
