import { describe, expect, it, vi } from "vitest";

import { memoizeIdentity, memoizeIdentityPerRequest } from "../src/memoize-identity";

const authed = (cookie = "session=abc"): Request => new Request("https://app.example/_lunora/rpc", { headers: { cookie }, method: "POST" });

const anonymous = (): Request => new Request("https://app.example/_lunora/rpc", { method: "POST" });

describe("memoizeIdentityPerRequest", () => {
    it("verifies once per request no matter how many code paths ask", async () => {
        expect.assertions(2);

        const resolver = vi.fn<() => Promise<{ userId: string }>>(async () => {
            return { userId: "u1" };
        });
        const memoized = memoizeIdentityPerRequest(resolver);
        const request = authed();

        // The runtime asks per RPC AND per fan-out leg, so a cross-shard query would
        // otherwise verify the session once per shard.
        const results = await Promise.all([memoized(request, {}), memoized(request, {}), memoized(request, {})]);

        expect(resolver).toHaveBeenCalledTimes(1);
        expect(results).toStrictEqual([{ userId: "u1" }, { userId: "u1" }, { userId: "u1" }]);
    });

    it("shares one in-flight verification between concurrent callers", async () => {
        expect.assertions(1);

        let release: (() => void) | undefined;
        const resolver = vi.fn<() => Promise<{ userId: string }>>(async () => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });

            return { userId: "u1" };
        });
        const memoized = memoizeIdentityPerRequest(resolver);
        const request = authed();

        const first = memoized(request, {});
        const second = memoized(request, {});

        release?.();
        await Promise.all([first, second]);

        // Caching the promise (not the result) is what makes two racing legs share one
        // verification instead of both starting their own.
        expect(resolver).toHaveBeenCalledTimes(1);
    });

    it("never reuses across requests, so a revoked session is re-verified immediately", async () => {
        expect.assertions(1);

        const resolver = vi.fn<() => Promise<{ userId: string }>>(async () => {
            return { userId: "u1" };
        });
        const memoized = memoizeIdentityPerRequest(resolver);

        await memoized(authed(), {});
        await memoized(authed(), {});

        expect(resolver).toHaveBeenCalledTimes(2);
    });
});

describe("memoizeIdentity", () => {
    it("reuses a verified identity for the same credential inside the TTL", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        try {
            const resolver = vi.fn<() => Promise<{ userId: string }>>(async () => {
                return { userId: "u1" };
            });
            const memoized = memoizeIdentity(resolver, { ttlMs: 5000 });

            await memoized(authed(), {});
            vi.advanceTimersByTime(1000);
            await memoized(authed(), {});

            expect(resolver).toHaveBeenCalledTimes(1);

            // Past the TTL the session is verified again — this window IS the
            // revocation delay.
            vi.advanceTimersByTime(5000);
            await memoized(authed(), {});

            expect(resolver).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("keys on the credential, so a different session is verified separately", async () => {
        expect.assertions(2);

        const resolver = vi.fn<(request: Request) => Promise<{ userId: string }>>(async (request: Request) => {
            return { userId: request.headers.get("cookie") ?? "" };
        });
        const memoized = memoizeIdentity(resolver);

        const first = await memoized(authed("session=a"), {});
        const second = await memoized(authed("session=b"), {});

        expect(resolver).toHaveBeenCalledTimes(2);
        expect([first?.userId, second?.userId]).toStrictEqual(["session=a", "session=b"]);
    });

    it("does not cache an anonymous request", async () => {
        expect.assertions(1);

        const resolver = vi.fn<() => Promise<null>>(async () => null);
        const memoized = memoizeIdentity(resolver);

        await memoized(anonymous(), {});
        await memoized(anonymous(), {});

        // Caching "anonymous" under an empty key would let one unauthenticated request
        // suppress verification for the next authenticated one.
        expect(resolver).toHaveBeenCalledTimes(2);
    });

    it("does not cache a failed verification", async () => {
        expect.assertions(2);

        let attempts = 0;
        const resolver = vi.fn<() => Promise<{ userId: string }>>(async () => {
            attempts += 1;

            if (attempts === 1) {
                throw new Error("jwks fetch failed");
            }

            return { userId: "u1" };
        });
        const memoized = memoizeIdentity(resolver);

        await expect(memoized(authed(), {})).rejects.toThrow("jwks fetch failed");

        // A transient failure must not be inherited for the whole TTL.
        await expect(memoized(authed(), {})).resolves.toStrictEqual({ userId: "u1" });
    });

    it("evicts the oldest entry past maxEntries", async () => {
        expect.assertions(2);

        const resolver = vi.fn<(request: Request) => Promise<{ userId: string }>>(async (request: Request) => {
            return { userId: request.headers.get("cookie") ?? "" };
        });
        const memoized = memoizeIdentity(resolver, { maxEntries: 2 });

        await memoized(authed("session=a"), {});
        await memoized(authed("session=b"), {});
        await memoized(authed("session=c"), {});

        expect(resolver).toHaveBeenCalledTimes(3);

        // `a` was evicted, so it verifies again; an unbounded map in a long-lived
        // isolate would be a leak.
        await memoized(authed("session=a"), {});

        expect(resolver).toHaveBeenCalledTimes(4);
    });

    it("still collapses duplicate calls within one request", async () => {
        expect.assertions(1);

        const resolver = vi.fn<() => Promise<{ userId: string }>>(async () => {
            return { userId: "u1" };
        });
        const memoized = memoizeIdentity(resolver, { ttlMs: 0 });
        const request = authed();

        // TTL 0 disables the cross-request cache; the per-request layer still applies.
        await Promise.all([memoized(request, {}), memoized(request, {})]);

        expect(resolver).toHaveBeenCalledTimes(1);
    });
});
