import type { Middleware, MiddlewareNext } from "@lunora/server";
import { describe, expect, it, vi } from "vitest";

import { rateLimit } from "../src/middleware";
import { RateLimiter } from "../src/rate-limiter";
import type { RateLimitDbQuery } from "../src/store";
import { createReadOnlyDbStore } from "../src/store";

interface Context {
    userId?: string;
}

const SENTINEL = "handler-ran";

const invoke = async <C>(middleware: Middleware<C, unknown>, context: C): Promise<{ called: boolean; result: unknown }> => {
    let called = false;
    const next = (() => {
        called = true;

        return Promise.resolve(SENTINEL);
    }) as MiddlewareNext<C>;

    const result = await middleware({ ctx: context, next });

    return { called, result };
};

const catchError = async (function_: () => Promise<unknown>): Promise<Record<string, unknown>> => {
    try {
        await function_();
    } catch (error) {
        return error as Record<string, unknown>;
    }

    throw new Error("expected the middleware to throw");
};

const makeLimiter = (denyList?: string[]) => new RateLimiter({ config: { api: { kind: "token bucket", period: 1000, rate: 1 } }, denyList, now: () => 0 });

describe("rateLimit middleware", () => {
    it("calls next when under the limit", async () => {
        expect.assertions(2);

        const middleware = rateLimit<Context>(makeLimiter(), "api");

        const { called, result } = await invoke(middleware, {});

        expect(called).toBe(true);
        expect(result).toBe(SENTINEL);
    });

    it("throws a structural LunoraError (429) once the limit is hit", async () => {
        expect.assertions(4);

        const middleware = rateLimit<Context>(makeLimiter(), "api");

        await invoke(middleware, {});
        const error = await catchError(() => invoke(middleware, {}));

        expect(error.name).toBe("LunoraError");
        expect(error.code).toBe("TOO_MANY_REQUESTS");
        expect(error.status).toBe(429);
        expect((error as Record<string, { retryAfter: number }>).data?.retryAfter).toBeTypeOf("number");
    });

    it("maps a deny-list hit to FORBIDDEN (403) without a retryAfter", async () => {
        expect.assertions(3);

        const middleware = rateLimit<Context>(makeLimiter(["banned"]), "api", { key: (context) => context.userId });

        const error = await catchError(() => invoke(middleware, { userId: "banned" }));

        expect(error.code).toBe("FORBIDDEN");
        expect(error.status).toBe(403);
        // Infinite retryAfter is dropped rather than serialized.
        expect(error.retryAfter).toBeUndefined();
    });

    it("isolates limits by the derived key", async () => {
        expect.assertions(2);

        const middleware = rateLimit<Context>(makeLimiter(), "api", { key: (context) => context.userId });

        await invoke(middleware, { userId: "alice" });

        await expect(catchError(() => invoke(middleware, { userId: "alice" }))).resolves.toMatchObject({ status: 429 });
        // Bob has his own bucket.
        await expect(invoke(middleware, { userId: "bob" })).resolves.toMatchObject({ called: true });
    });

    it("fails closed when the key resolver returns undefined instead of pooling callers", async () => {
        expect.assertions(3);

        // Anonymous callers resolve to no key; silently falling back to the
        // global bucket would let one of them drain the limit for all.
        const middleware = rateLimit<Context>(makeLimiter(), "api", { key: (context) => context.userId });

        const error = await catchError(() => invoke(middleware, {}));

        expect(error.name).toBe("LunoraError");
        expect(error.code).toBe("INTERNAL");
        expect(error.message).toMatch(/key resolver returned undefined/u);
    });

    it("accepts a per-ctx limiter resolver", async () => {
        expect.assertions(1);

        const shared = makeLimiter();
        const middleware = rateLimit<Context>((_context) => shared, "api");

        const { called } = await invoke(middleware, {});

        expect(called).toBe(true);
    });

    it("honors a custom message", async () => {
        expect.assertions(1);

        const middleware = rateLimit<Context>(makeLimiter(), "api", { message: "slow down" });

        await invoke(middleware, {});
        const error = await catchError(() => invoke(middleware, {}));

        expect(error.message).toBe("slow down");
    });

    it("rethrows deterministic misuse (INTERNAL) instead of masking it, even with failOpen", async () => {
        expect.assertions(3);

        // count 20 against a capacity-5 fixed window is never admittable — an
        // INTERNAL config bug, not a store outage. failOpen must NOT swallow it
        // into a silent no-op; it must surface as INTERNAL.
        const limiter = new RateLimiter({ config: { api: { kind: "fixed window", period: 1000, rate: 5 } }, now: () => 0 });
        const middleware = rateLimit<Context>(limiter, "api", { count: 20, failOpen: true });

        const error = await catchError(() => invoke(middleware, {}));

        expect(error.name).toBe("LunoraError");
        expect(error.code).toBe("INTERNAL");
        expect(error.status).not.toBe(503);
    });

    it("throws on a read-only store write instead of admitting under failOpen", async () => {
        expect.assertions(3);

        // A limiter wired to a query-context `ctx.db` appears to consume budget
        // but cannot write. That is deterministic misuse, not a store outage —
        // failOpen must surface it, not admit every request forever.
        const query: RateLimitDbQuery = { first: async () => null, withIndex: () => query };
        const limiter = new RateLimiter({
            config: { api: { kind: "token bucket", period: 1000, rate: 1 } },
            now: () => 0,
            store: createReadOnlyDbStore({ db: { query: () => query } }),
        });
        const middleware = rateLimit<Context>(limiter, "api", { failOpen: true });

        const error = await catchError(() => invoke(middleware, {}));

        expect(error.name).toBe("LunoraError");
        expect(error.code).toBe("INTERNAL");
        expect(error.message).toMatch(/createReadOnlyDbStore/u);
    });

    // A store outage is NOT a LunoraError, so it falls past the INTERNAL rethrow and
    // reaches the failure policy — the only path that reads `options.failOpen`.
    const outageLimiter = (): RateLimiter =>
        new RateLimiter({
            config: { api: { kind: "token bucket", period: 1000, rate: 1 } },
            now: () => 0,
            store: {
                delete: () => {
                    throw new Error("store offline");
                },
                get: () => {
                    throw new Error("store offline");
                },
                set: () => {
                    throw new Error("store offline");
                },
            },
        });

    it("fails closed by default on a store outage, denying with 503", async () => {
        expect.assertions(5);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const middleware = rateLimit<Context>(outageLimiter(), "api");

            const error = await catchError(() => invoke(middleware, {}));

            expect(error.name).toBe("LunoraError");
            expect(error.code).toBe("SERVICE_UNAVAILABLE");
            expect(error.status).toBe(503);
            expect((error as { cause?: Error }).cause).toMatchObject({ message: "store offline" });
            // The outage is only observable through console.error — nothing else reports it.
            expect(logged).toHaveBeenCalledWith(expect.stringContaining('rateLimit("api") threw; failing closed'), expect.anything());
        } finally {
            logged.mockRestore();
        }
    });

    it("admits the request under failOpen on a store outage", async () => {
        expect.assertions(3);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const middleware = rateLimit<Context>(outageLimiter(), "api", { failOpen: true });

            const { called, result } = await invoke(middleware, {});

            expect(called).toBe(true);
            expect(result).toBe(SENTINEL);
            expect(logged).toHaveBeenCalledWith(expect.stringContaining('rateLimit("api") threw; failing open'), expect.anything());
        } finally {
            logged.mockRestore();
        }
    });

    it("fails closed when the limiter RESOLVER itself throws", async () => {
        expect.assertions(2);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const middleware = rateLimit<Context>(() => {
                throw new Error("db binding missing");
            }, "api");

            const error = await catchError(() => invoke(middleware, {}));

            expect(error.status).toBe(503);
            expect((error as { cause?: Error }).cause).toMatchObject({ message: "db binding missing" });
        } finally {
            logged.mockRestore();
        }
    });
});
