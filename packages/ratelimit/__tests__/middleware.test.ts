import type { Middleware, MiddlewareNext } from "@cirrus/server";
import { describe, expect, test } from "vitest";

import { rateLimit } from "../src/middleware.js";
import { RateLimiter } from "../src/rate-limiter.js";

interface Ctx {
    userId?: string;
}

const SENTINEL = "handler-ran";

const invoke = async <C>(middleware: Middleware<C, unknown>, ctx: C): Promise<{ called: boolean; result: unknown }> => {
    let called = false;
    const next = (() => {
        called = true;

        return Promise.resolve(SENTINEL);
    }) as MiddlewareNext<C>;

    const result = await middleware({ ctx, next });

    return { called, result };
};

const catchError = async (fn: () => Promise<unknown>): Promise<Record<string, unknown>> => {
    try {
        await fn();
    } catch (error) {
        return error as Record<string, unknown>;
    }

    throw new Error("expected the middleware to throw");
};

const makeLimiter = (denyList?: string[]) => new RateLimiter({ config: { api: { kind: "token bucket", period: 1000, rate: 1 } }, denyList, now: () => 0 });

describe("rateLimit middleware", () => {
    test("calls next when under the limit", async () => {
        const middleware = rateLimit<Ctx>(makeLimiter(), "api");

        const { called, result } = await invoke(middleware, {});

        expect(called).toBe(true);
        expect(result).toBe(SENTINEL);
    });

    test("throws a structural CirrusError (429) once the limit is hit", async () => {
        const middleware = rateLimit<Ctx>(makeLimiter(), "api");

        await invoke(middleware, {});
        const error = await catchError(() => invoke(middleware, {}));

        expect(error.name).toBe("CirrusError");
        expect(error.code).toBe("TOO_MANY_REQUESTS");
        expect(error.status).toBe(429);
        expect(error.retryAfter).toBeTypeOf("number");
    });

    test("maps a deny-list hit to FORBIDDEN (403) without a retryAfter", async () => {
        const middleware = rateLimit<Ctx>(makeLimiter(["banned"]), "api", { key: (ctx) => ctx.userId });

        const error = await catchError(() => invoke(middleware, { userId: "banned" }));

        expect(error.code).toBe("FORBIDDEN");
        expect(error.status).toBe(403);
        // Infinite retryAfter is dropped rather than serialized.
        expect(error.retryAfter).toBeUndefined();
    });

    test("isolates limits by the derived key", async () => {
        const middleware = rateLimit<Ctx>(makeLimiter(), "api", { key: (ctx) => ctx.userId });

        await invoke(middleware, { userId: "alice" });

        await expect(catchError(() => invoke(middleware, { userId: "alice" }))).resolves.toMatchObject({ status: 429 });
        // Bob has his own bucket.
        await expect(invoke(middleware, { userId: "bob" })).resolves.toMatchObject({ called: true });
    });

    test("accepts a per-ctx limiter resolver", async () => {
        const shared = makeLimiter();
        const middleware = rateLimit<Ctx>((_ctx) => shared, "api");

        const { called } = await invoke(middleware, {});

        expect(called).toBe(true);
    });

    test("honors a custom message", async () => {
        const middleware = rateLimit<Ctx>(makeLimiter(), "api", { message: "slow down" });

        await invoke(middleware, {});
        const error = await catchError(() => invoke(middleware, {}));

        expect(error.message).toBe("slow down");
    });
});
