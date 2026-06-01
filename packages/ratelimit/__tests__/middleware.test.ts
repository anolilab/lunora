import type { Middleware, MiddlewareNext } from "@cirrus/server";
import { describe, expect, it } from "vitest";

import { rateLimit } from "../src/middleware.js";
import { RateLimiter } from "../src/rate-limiter.js";

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

    it("throws a structural CirrusError (429) once the limit is hit", async () => {
        expect.assertions(4);

        const middleware = rateLimit<Context>(makeLimiter(), "api");

        await invoke(middleware, {});
        const error = await catchError(() => invoke(middleware, {}));

        expect(error.name).toBe("CirrusError");
        expect(error.code).toBe("TOO_MANY_REQUESTS");
        expect(error.status).toBe(429);
        expect(error.retryAfter).toBeTypeOf("number");
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
});
