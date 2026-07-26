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

    it("treats a refresh as recent, so a hot credential isn't evicted before staler ones", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        try {
            const resolver = vi.fn<(request: Request) => Promise<{ userId: string }>>(async (request: Request) => {
                return { userId: request.headers.get("cookie") ?? "" };
            });
            const memoized = memoizeIdentity(resolver, { maxEntries: 2, ttlMs: 1000 });

            await memoized(authed("session=hot"), {});
            await memoized(authed("session=other"), {});

            // Expire `hot` and refresh it. `Map.set` on an existing key keeps its ORIGINAL
            // position, so without an explicit delete-then-set `hot` stays at the front
            // and is the next thing evicted despite just being used.
            vi.advanceTimersByTime(1500);
            await memoized(authed("session=hot"), {});

            // Admitting a third key evicts the least-recently-used, which is `other`.
            await memoized(authed("session=third"), {});

            const callsBefore = resolver.mock.calls.length;

            // `hot` must still be cached.
            await memoized(authed("session=hot"), {});

            expect(resolver).toHaveBeenCalledTimes(callsBefore);

            // …and `other` must be the one that was dropped.
            await memoized(authed("session=other"), {});

            expect(resolver).toHaveBeenCalledTimes(callsBefore + 1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("keys on a custom cacheKey, so principals sharing Cookie/Authorization are cached separately", async () => {
        expect.assertions(3);

        // A resolver that authenticates off `X-API-Key`, NOT the cookie. Two requests
        // carry an identical cookie (so the default credential key would collide them
        // onto one entry and serve the first principal's identity to the second) but
        // different API keys → different principals.
        const resolver = vi.fn<(request: Request) => Promise<{ userId: string }>>(async (request: Request) => {
            return { userId: request.headers.get("x-api-key") ?? "" };
        });
        const memoized = memoizeIdentity(resolver, {
            cacheKey: (request) => request.headers.get("x-api-key") ?? undefined,
        });

        const withApiKey = (apiKey: string): Request =>
            new Request("https://app.example/_lunora/rpc", {
                headers: { cookie: "session=shared", "x-api-key": apiKey },
                method: "POST",
            });

        const first = await memoized(withApiKey("key-alice"), {});
        const second = await memoized(withApiKey("key-bob"), {});

        // Distinguished by the custom key despite the identical cookie: two
        // verifications, each principal getting its own identity.
        expect(resolver).toHaveBeenCalledTimes(2);
        expect([first?.userId, second?.userId]).toStrictEqual(["key-alice", "key-bob"]);

        // …and the same API key still shares a cache entry (one more verification total).
        await memoized(withApiKey("key-alice"), {});

        expect(resolver).toHaveBeenCalledTimes(2);
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
