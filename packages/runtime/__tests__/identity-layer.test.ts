import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodeIdentityHeader } from "../../../shared/identity-header";
import type { ExecutionContextLike, ResolvedIdentity } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { IdentityContractLike, IdentityResolver } from "../src/identity-resolvers";
import { composeIdentityResolvers, routeIdentityResolvers } from "../src/identity-resolvers";
import type { ShardNamespaceLike } from "../src/resolve-shard";

interface ShardSpy {
    calls: { request: Request; shardKey: string }[];
    namespace: ShardNamespaceLike;
    response: Response;
}

const createShardSpy = (response = new Response("ok", { status: 200 })): ShardSpy => {
    const calls: { request: Request; shardKey: string }[] = [];
    const spy = { calls, response } as ShardSpy;

    spy.namespace = {
        get: (id) => {
            const shardKey = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    calls.push({ request, shardKey });

                    return spy.response;
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return spy;
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const rpc = (): Request =>
    new Request("https://app.example/_lunora/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
        method: "POST",
    });

const rpcBatch = (): Request =>
    new Request("https://app.example/_lunora/rpc-batch", {
        body: JSON.stringify({ calls: [{ args: {}, functionPath: "messages:list" }] }),
        method: "POST",
    });

/** A contract that requires a numeric-string `tenantId` claim beyond `userId`. */
const tenantContract = (onInvalid: "anonymous" | "reject"): IdentityContractLike => {
    return {
        onInvalid,
        validate: (identity) => {
            if (typeof identity["tenantId"] !== "string" || identity["tenantId"].length === 0) {
                return { error: "identity.tenantId: expected a non-empty string", ok: false };
            }

            return { ok: true };
        },
    };
};

describe("composeIdentityResolvers", () => {
    it("returns the first non-null identity (first-match-wins) and short-circuits", async () => {
        expect.assertions(3);

        const first = vi.fn<IdentityResolver>(() => null);
        const second = vi.fn<IdentityResolver>(() => {
            return { userId: "u_2" };
        });
        const third = vi.fn<IdentityResolver>(() => {
            return { userId: "u_3" };
        });

        const resolver = composeIdentityResolvers([first, second, third]);
        const identity = await resolver(rpc(), {});

        expect(identity).toEqual({ userId: "u_2" });
        expect(second).toHaveBeenCalledTimes(1);
        // third must never run — second already matched.
        expect(third).not.toHaveBeenCalled();
    });

    it("returns null when every resolver is anonymous", async () => {
        expect.assertions(1);

        const resolver = composeIdentityResolvers([() => null, () => null]);

        await expect(resolver(rpc(), {})).resolves.toBeNull();
    });

    it("fails closed by default when a resolver throws", async () => {
        expect.assertions(2);

        const boom = vi.fn<IdentityResolver>(() => {
            throw new Error("verifier down");
        });
        const fallback = vi.fn<IdentityResolver>(() => {
            return { userId: "u_fallback" };
        });

        const resolver = composeIdentityResolvers([boom, fallback]);

        await expect(resolver(rpc(), {})).rejects.toThrow("verifier down");
        // fail-closed: a broken verifier must not fall through to a weaker one.
        expect(fallback).not.toHaveBeenCalled();
    });

    it("skips a throwing resolver when onError is 'skip'", async () => {
        expect.assertions(1);

        const resolver = composeIdentityResolvers(
            [
                () => {
                    throw new Error("not my scheme");
                },
                () => {
                    return { userId: "u_next" };
                },
            ],
            { onError: "skip" },
        );

        await expect(resolver(rpc(), {})).resolves.toEqual({ userId: "u_next" });
    });
});

describe("routeIdentityResolvers", () => {
    const at = (path: string): Request => new Request(`https://app.example${path}`);

    it("dispatches by longest path prefix, falling back to '*'", async () => {
        expect.assertions(3);

        const resolver = routeIdentityResolvers({
            "*": () => {
                return { userId: "default" };
            },
            "/admin": () => {
                return { userId: "admin" };
            },
            "/admin/reports": () => {
                return { userId: "reports" };
            },
        });

        // `Promise.resolve` normalises the (synchronous) route dispatch to a
        // promise so `.resolves` is valid whether a resolver is sync or async.
        await expect(Promise.resolve(resolver(at("/admin/reports/q1"), {}))).resolves.toEqual({ userId: "reports" });
        await expect(Promise.resolve(resolver(at("/admin/users"), {}))).resolves.toEqual({ userId: "admin" });
        await expect(Promise.resolve(resolver(at("/dashboard"), {}))).resolves.toEqual({ userId: "default" });
    });

    it("returns null when no route matches and no '*' fallback is declared", async () => {
        expect.assertions(1);

        const resolver = routeIdentityResolvers({
            "/admin": () => {
                return { userId: "admin" };
            },
        });

        await expect(Promise.resolve(resolver(at("/dashboard"), {}))).resolves.toBeNull();
    });

    it("awaits an async resolver (and a composed resolver) selected by route", async () => {
        expect.assertions(2);

        const resolver = routeIdentityResolvers({
            "*": composeIdentityResolvers([
                async () => null,
                async () => {
                    return { userId: "composed" };
                },
            ]),
            "/admin": async () => {
                return { userId: "admin-async" };
            },
        });

        // The chosen resolver returns a promise; `routeIdentityResolvers` must pass it
        // through so `await` resolves the identity rather than yielding a Promise.
        await expect(resolver(at("/admin/reports"), {})).resolves.toEqual({ userId: "admin-async" });
        await expect(resolver(at("/dashboard"), {})).resolves.toEqual({ userId: "composed" });
    });
});

describe("identity contract trust boundary", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    it("forwards a valid identity unchanged when it satisfies the contract", async () => {
        expect.assertions(2);

        const worker = createWorker({
            identity: tenantContract("anonymous"),
            resolveIdentity: (): ResolvedIdentity => {
                return { tenantId: "t_1", userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(rpc(), {}, fakeContext);

        expect(shard.calls[0]!.request.headers.get("x-lunora-userid")).toBe("user_42");
        expect(decodeIdentityHeader(shard.calls[0]!.request.headers.get("x-lunora-identity"))).toEqual({ tenantId: "t_1" });
    });

    it("downgrades a contract-violating identity to anonymous (onInvalid: 'anonymous')", async () => {
        expect.assertions(2);

        const worker = createWorker({
            identity: tenantContract("anonymous"),
            // Forged: `userId` present but the required `tenantId` claim is missing.
            resolveIdentity: (): ResolvedIdentity => {
                return { userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(rpc(), {}, fakeContext);

        expect(res.status).toBe(200);
        // The bad identity never reaches the shard as a valid identity.
        expect(shard.calls[0]!.request.headers.get("x-lunora-userid")).toBeNull();
    });

    it("rejects a contract-violating identity with 401 (onInvalid: 'reject')", async () => {
        expect.assertions(3);

        const worker = createWorker({
            identity: tenantContract("reject"),
            resolveIdentity: (): ResolvedIdentity => {
                return { userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(rpc(), {}, fakeContext);

        expect(res.status).toBe(401);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
        // Request never dispatched to the shard.
        expect(shard.calls).toHaveLength(0);
    });

    it("rejects a contract-violating identity with 401 on the batch path (onInvalid: 'reject')", async () => {
        expect.assertions(3);

        const worker = createWorker({
            identity: tenantContract("reject"),
            resolveIdentity: (): ResolvedIdentity => {
                return { userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        // The batch transport (/_lunora/rpc-batch) is a public data path and must
        // enforce the identity contract exactly like /_lunora/rpc — otherwise a
        // contract-violating identity reaches the shard verbatim through the batch.
        const res = await worker.fetch(rpcBatch(), {}, fakeContext);

        expect(res.status).toBe(401);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
        expect(shard.calls).toHaveLength(0);
    });

    it("does not enforce the contract when no resolveIdentity is configured", async () => {
        expect.assertions(1);

        const worker = createWorker({ identity: tenantContract("reject"), shardDO: shard.namespace });

        const res = await worker.fetch(rpc(), {}, fakeContext);

        expect(res.status).toBe(200);
    });
});
