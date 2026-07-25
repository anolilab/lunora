import { describe, expect, it, vi } from "vitest";

import type { DurableObjectJurisdiction, ShardNamespaceLike } from "../src/resolve-shard";
import { applyJurisdiction, resolveShard } from "../src/resolve-shard";

const fakeStub = { fetch: async () => new Response("ok") };

/**
 * Namespace double that records `jurisdiction()` calls and returns a distinct
 * subnamespace, mirroring Cloudflare's `DurableObjectNamespace.jurisdiction`.
 */
const createNamespace = (): ShardNamespaceLike & { jurisdictionCalls: string[] } => {
    const jurisdictionCalls: string[] = [];

    const base: ShardNamespaceLike & { jurisdictionCalls: string[] } = {
        get: () => fakeStub,
        idFromName: (name) => {
            return { __name: name };
        },
        jurisdiction: (j: DurableObjectJurisdiction) => {
            jurisdictionCalls.push(j);

            // Subnamespace: same shape, no further `.jurisdiction` needed here.
            return {
                get: () => fakeStub,
                idFromName: (name) => {
                    return { __name: name, __jurisdiction: j };
                },
            };
        },
        jurisdictionCalls,
    };

    return base;
};

describe("applyJurisdiction", () => {
    it("returns the namespace unchanged when no jurisdiction is given", () => {
        expect.assertions(2);

        const namespace = createNamespace();
        const result = applyJurisdiction(namespace);

        expect(result).toBe(namespace);
        expect(namespace.jurisdictionCalls).toStrictEqual([]);
    });

    it("derives a jurisdiction-restricted subnamespace when given one", () => {
        expect.assertions(2);

        const namespace = createNamespace();
        const result = applyJurisdiction(namespace, "us");

        expect(namespace.jurisdictionCalls).toStrictEqual(["us"]);
        // The subnamespace pins IDs to the jurisdiction.
        expect(result.idFromName("user:1")).toStrictEqual({ __jurisdiction: "us", __name: "user:1" });
    });

    it.each(["eu", "us", "fedramp"] as const)("supports the %s jurisdiction", (j) => {
        expect.assertions(1);

        const namespace = createNamespace();

        applyJurisdiction(namespace, j);

        expect(namespace.jurisdictionCalls).toStrictEqual([j]);
    });

    it("fails closed when a jurisdiction is requested but the binding lacks support", () => {
        expect.assertions(1);

        // An older workers-types binding (no `.jurisdiction`): must throw rather
        // than silently routing to the un-pinned global namespace.
        const legacy: ShardNamespaceLike = {
            get: () => fakeStub,
            idFromName: (name) => {
                return { __name: name };
            },
        };

        expect(() => applyJurisdiction(legacy, "eu")).toThrow(/does not support jurisdiction/);
    });
});

describe("resolveShard", () => {
    it("prefers getByName when present", () => {
        expect.assertions(2);

        const emptyId: unknown = {};
        const getByName = vi.fn<() => typeof fakeStub>(() => fakeStub);
        const idFromName = vi.fn<() => unknown>(() => emptyId);
        const namespace: ShardNamespaceLike = { get: () => fakeStub, getByName, idFromName };

        resolveShard(namespace, "room-7");

        expect(getByName).toHaveBeenCalledWith("room-7");
        expect(idFromName).not.toHaveBeenCalled();
    });

    it("calls getByName with the namespace as its receiver, not the adapter", () => {
        expect.assertions(2);

        // `DurableObjectNamespace`'s methods are NATIVE and require their own
        // receiver. Passing one by reference (`getByName: namespace.getByName`)
        // type-checks and works against every closure-based double above, then
        // fails in workerd with "Illegal invocation" — because the contract calls
        // it with the `ShardDirectory` object as `this`. Only asserting the
        // receiver catches that here rather than in a workerd suite.
        const receivers: unknown[] = [];

        const namespace = {
            get: () => fakeStub,
            getByName(this: unknown) {
                receivers.push(this);

                return fakeStub;
            },
            idFromName: (name: string) => {
                return { __name: name };
            },
        };

        resolveShard(namespace, "room-7");

        expect(receivers[0]).toBe(namespace);

        // Same hazard on the fallback path.
        const bare = {
            get: () => fakeStub,
            idFromName(this: unknown, name: string) {
                receivers.push(this);

                return { __name: name };
            },
        };

        resolveShard(bare, "room-7");

        expect(receivers[1]).toBe(bare);
    });

    it("falls back to idFromName + get when getByName is absent", () => {
        expect.assertions(2);

        const id = { __id: 1 };
        const get = vi.fn<() => typeof fakeStub>(() => fakeStub);
        const idFromName = vi.fn<() => typeof id>(() => id);
        const namespace: ShardNamespaceLike = { get, idFromName };

        resolveShard(namespace, "room-7");

        expect(idFromName).toHaveBeenCalledWith("room-7");
        expect(get).toHaveBeenCalledWith(id);
    });

    it("resolves against a jurisdiction-pinned subnamespace", () => {
        expect.assertions(1);

        const namespace = createNamespace();
        const pinned = applyJurisdiction(namespace, "eu");

        const stub = resolveShard(pinned, "room-7");

        expect(stub).toBe(fakeStub);
    });
});
