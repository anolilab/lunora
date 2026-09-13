/**
 * The reactive cache and the `internal` visibility gate.
 *
 * That gate lives INSIDE the emitted `handleRpc` — the callback a cache hit
 * exists to skip. Classifying cacheability on `kind` alone let an `internalQuery`
 * route through `runCachedQuery` like any other query, and on a hit
 * `ReactiveCache` returns the stored result without invoking the callback, so the
 * gate never ran. Nothing about the trusted-dispatch flag reached the key either.
 *
 * A server-side dispatch (cron, an `httpRouter` route, `createShardClient`, the
 * mail inbound dispatcher) arrives with `x-lunora-system: 1`, primes the entry,
 * and an anonymous client POSTing the same path and args was handed it.
 *
 * Two independent defences now, tested separately because either alone closes it
 * and neither should be allowed to rot behind the other. First, an internal
 * function is not cacheable at all (`isCacheableQuery`). Second, the
 * trusted-dispatch flag is part of the caller context the key is built from, so a
 * client could not read a system dispatch's entry even if it were.
 */
import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import type { QueryReadScope, ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

const REGISTRY: Readonly<Record<string, { kind: "query"; visibility: "internal" | "public" }>> = {
    "posts:list": { kind: "query", visibility: "public" },
    "secrets:listAll": { kind: "query", visibility: "internal" },
};

const createFakeState = (): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets: () => [],
        storage: { sql: { exec: vi.fn<(query: string) => unknown>() } },
    };
};

/** Mirrors the emitted subclass: the gate inside `handleRpc`, the registry lookup in `isCacheableQuery`. */
class VisibilityShard extends ShardDO {
    public handlerRuns = 0;

    public override handleRpc(functionPath: string, _args: Record<string, unknown>, _headroom?: unknown, _scope?: QueryReadScope): Promise<unknown> {
        const registered = REGISTRY[functionPath];

        if (!registered || (registered.visibility === "internal" && !this.isSystemDispatch())) {
            throw new LunoraError("FUNCTION_NOT_FOUND", `function not registered: ${functionPath}`);
        }

        this.handlerRuns += 1;

        return Promise.resolve({ rows: ["internal-only-row"] });
    }

    // eslint-disable-next-line class-methods-use-this -- mirrors the emitted override verbatim.
    protected override isCacheableQuery(functionPath: string): boolean {
        const registered = REGISTRY[functionPath];

        return registered?.kind === "query" && registered.visibility !== "internal";
    }
}

/**
 * The same shard with the OLD, kind-only classification restored, so an internal
 * function reaches the cache again. What must still refuse the client here is the
 * key: the trusted-dispatch flag is part of the caller context it is built from.
 */
class KindOnlyVisibilityShard extends VisibilityShard {
    // eslint-disable-next-line class-methods-use-this -- deliberately the pre-fix classification; the key is what is under test.
    protected override isCacheableQuery(functionPath: string): boolean {
        return REGISTRY[functionPath]?.kind === "query";
    }
}

const rpc = async (shard: VisibilityShard, functionPath: string, system: boolean): Promise<{ body: unknown; status: number }> => {
    const response = await shard.fetch(
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath }),
            headers: system ? { "content-type": "application/json", "x-lunora-system": "1" } : { "content-type": "application/json" },
            method: "POST",
        }),
    );

    return { body: await response.json(), status: response.status };
};

describe("reactive cache + internal visibility", () => {
    it("refuses an anonymous client an internal query a system dispatch just ran", async () => {
        expect.hasAssertions();

        const shard = new VisibilityShard(createFakeState(), {}, { reactiveCache: {} });

        // A trusted server-side dispatch runs the internal query.
        const system = await rpc(shard, "secrets:listAll", true);

        expect(system.status).toBe(200);

        // The anonymous client must still be refused — a hit must not answer for
        // a gate that never ran.
        const client = await rpc(shard, "secrets:listAll", false);

        expect(client.status).toBe(404);
        expect(shard.handlerRuns).toBe(1);
    });

    it("refuses it through the key alone, even when an internal function does reach the cache", async () => {
        expect.hasAssertions();

        const shard = new KindOnlyVisibilityShard(createFakeState(), {}, { reactiveCache: {} });

        await rpc(shard, "secrets:listAll", true);
        const client = await rpc(shard, "secrets:listAll", false);

        expect(client.status).toBe(404);
        expect(shard.handlerRuns).toBe(1);
    });

    it("still memoizes a public query across two anonymous callers", async () => {
        expect.hasAssertions();

        const shard = new VisibilityShard(createFakeState(), {}, { reactiveCache: {} });

        await rpc(shard, "posts:list", false);
        const second = await rpc(shard, "posts:list", false);

        expect(second.status).toBe(200);
        expect(shard.handlerRuns).toBe(1);
    });
});
