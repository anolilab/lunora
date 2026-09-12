/**
 * Per-dispatch middleware and the reactive cache.
 *
 * A cache HIT returns the stored entry without invoking the dispatch callback,
 * so nothing inside `handleRpc` runs — and a `.use(rateLimit(...))` step is
 * inside it, because the middleware chain is part of the registered function's
 * own handler. The gates in the base `fetch` (paywall, watermark, dedup) run
 * before the callback and are unaffected; a limiter the AUTHOR attached to the
 * procedure is not.
 *
 * The consequence is not a stale answer but an unmetered one: the requests still
 * reach the Durable Object and still cost it a dispatch, and only the accounting
 * is skipped. So a cached query can be hammered for free.
 *
 * `isCacheableQuery` is where this is settled — the same seam that already keeps
 * `internal` functions out of the cache because a hit would skip their refusal.
 * The emitted override now also refuses a function whose chain carries a
 * per-dispatch middleware; this file pins the base class's half: what it does
 * with each answer.
 */
import { describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

const createFakeState = (): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets: () => [],
        storage: { sql: { exec: vi.fn<(query: string) => unknown>() } },
    };
};

/**
 * Stands in for what the emitter produces for a procedure built as
 * `query.use(rateLimit(limiter, "feed")).query(...)`: the limiter is consumed by
 * the middleware chain, which `registered.handler` runs before the user handler
 * — all of it inside `handleRpc`, i.e. inside the cache callback.
 *
 * `cacheable` mirrors the emitted `isCacheableQuery`: the paths it admits are
 * memoized, the paths it refuses dispatch every time.
 */
class MeteredShard extends ShardDO {
    /** Units the limiter has been charged, per function path. */
    public charged = new Map<string, number>();

    private readonly cacheable: (functionPath: string) => boolean;

    public constructor(state: ShardDOState, cacheable: (functionPath: string) => boolean) {
        super(state, {}, { reactiveCache: {} });
        this.cacheable = cacheable;
    }

    public override handleRpc(functionPath: string): Promise<unknown> {
        // `.use(rateLimit(...))` — runs as part of the handler, so it runs only
        // when the handler runs.
        this.charged.set(functionPath, (this.charged.get(functionPath) ?? 0) + 1);

        return Promise.resolve({ ok: true });
    }

    protected override isCacheableQuery(functionPath: string): boolean {
        return this.cacheable(functionPath);
    }
}

const rpc = async (shard: MeteredShard, functionPath: string): Promise<void> => {
    await shard.fetch(
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
    );
};

describe("reactive cache + per-dispatch middleware", () => {
    it("consumes no limiter budget on a hit when the path is admitted to the cache", async () => {
        expect.hasAssertions();

        // The defect, pinned: admitted to the cache, the second and third
        // dispatches are answered from the memo and the limiter never sees them.
        const shard = new MeteredShard(createFakeState(), () => true);

        await rpc(shard, "posts:feed");
        await rpc(shard, "posts:feed");
        await rpc(shard, "posts:feed");

        expect(shard.charged.get("posts:feed")).toBe(1);
    });

    it("charges the limiter on every dispatch of a path the cache refuses", async () => {
        expect.hasAssertions();

        const shard = new MeteredShard(createFakeState(), () => false);

        await rpc(shard, "posts:feed");
        await rpc(shard, "posts:feed");
        await rpc(shard, "posts:feed");

        expect(shard.charged.get("posts:feed")).toBe(3);
    });
});
