/**
 * `ctx.ip` and the reactive cache key.
 *
 * `runCachedQuery` scopes each entry to the caller's full identity — userId plus
 * the `getIdentity()` claims — precisely so that ambient per-request state one
 * caller's rows were computed under is never handed to another. `ctx.ip` is
 * ambient per-request state of exactly the same kind, and it was left out: two
 * anonymous callers both collapse to the `null` identity bucket, so under
 * `.reactiveCache(true)` the second is served the first's answer — including
 * the first caller's address.
 *
 * Every registered `query` reaching `POST /rpc` routes through `runCachedQuery`,
 * so this is not confined to one socket's refresh.
 */
import { describe, expect, it, vi } from "vitest";

import type { QueryReadScope, ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

const CALLER_A_IP = "203.0.113.5";
const CALLER_B_IP = "198.51.100.1";

const createFakeState = (): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets: () => [],
        storage: { sql: { exec: vi.fn<(query: string) => unknown>() } },
    };
};

/**
 * Mirrors what the emitter produces: a plain `handleRpc` with no cache wrap of
 * its own, whose handler reaches the caller's address through the ctx the
 * generated `buildCtx` builds — where `ip` is a getter that marks the dispatch's
 * read scope. `emit-shard-reactive-cache.test.ts` holds the emitter to that
 * shape; this file asserts what the base class does with the mark.
 *
 * `whoami` reads the address, `feed` never does — the pair that shows the key is
 * widened for the former and left alone for the latter.
 */
class IpReadingShard extends ShardDO {
    public execCount = new Map<string, number>();

    public override handleRpc(functionPath: string, _args: Record<string, unknown>, _headroom?: unknown, scope?: QueryReadScope): Promise<unknown> {
        this.execCount.set(functionPath, (this.execCount.get(functionPath) ?? 0) + 1);

        const readIp = (): string | undefined => {
            scope?.markIpRead();

            return this.getCurrentIp();
        };
        const ctx = {
            get ip(): string | undefined {
                return readIp();
            },
        };

        // Only `whoami` touches `ctx.ip`; `feed` is the ordinary query that must
        // keep sharing one entry across callers.
        return Promise.resolve({ ip: functionPath === "session:whoami" ? (ctx.ip ?? null) : null });
    }

    /** Test-only: expose the protected `reactiveCache` field for assertions. */
    public cacheRef(): typeof this.reactiveCache {
        return this.reactiveCache;
    }

    // eslint-disable-next-line class-methods-use-this -- test stub: every path in this harness is a query.
    protected override isCacheableQuery(): boolean {
        return true;
    }
}

const rpc = async (shard: IpReadingShard, functionPath: string, ip: string): Promise<{ ip: null | string }> => {
    const response = await shard.fetch(
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath }),
            headers: { "content-type": "application/json", "x-lunora-client-ip": ip },
            method: "POST",
        }),
    );

    const body: { result: { ip: null | string } } = await response.json();

    return body.result;
};

describe("reactive cache + ctx.ip", () => {
    it("never serves one anonymous caller a result computed under another caller's ip", async () => {
        expect.hasAssertions();

        const shard = new IpReadingShard(createFakeState(), {}, { reactiveCache: {} });

        const a = await rpc(shard, "session:whoami", CALLER_A_IP);
        const b = await rpc(shard, "session:whoami", CALLER_B_IP);

        expect(a.ip).toBe(CALLER_A_IP);
        expect(b.ip).toBe(CALLER_B_IP);
    });

    it("re-serves the memo to a repeat caller from the same address", async () => {
        expect.hasAssertions();

        const shard = new IpReadingShard(createFakeState(), {}, { reactiveCache: {} });

        // The first dispatch is what DISCOVERS the read, so its entry sits under
        // the address-less key; the second widens the key and re-runs. From the
        // third on the same caller hits.
        await rpc(shard, "session:whoami", CALLER_A_IP);
        await rpc(shard, "session:whoami", CALLER_A_IP);
        const third = await rpc(shard, "session:whoami", CALLER_A_IP);

        expect(third.ip).toBe(CALLER_A_IP);
        expect(shard.execCount.get("session:whoami")).toBe(2);
    });

    it("leaves a query that never reads ctx.ip sharing one entry across callers", async () => {
        expect.hasAssertions();

        const shard = new IpReadingShard(createFakeState(), {}, { reactiveCache: {} });

        await rpc(shard, "posts:feed", CALLER_A_IP);
        await rpc(shard, "posts:feed", CALLER_B_IP);

        // Unconditional address-keying would make this 2 — the hit-rate
        // regression the mark exists to avoid.
        expect(shard.execCount.get("posts:feed")).toBe(1);
        expect(shard.cacheRef()?.stats().hits).toBe(1);
    });
});
