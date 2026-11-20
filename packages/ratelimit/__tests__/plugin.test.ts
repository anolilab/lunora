import { initLunora, isPerDispatchMiddleware } from "@lunora/server";
import { describe, expect, it } from "vitest";

import { ratelimitPlugin } from "../src/plugin";
import { RateLimiter } from "../src/rate-limiter";

const makeLimiter = (): RateLimiter =>
    new RateLimiter({
        config: { send: { capacity: 2, kind: "token bucket", period: 60_000, rate: 2 } },
    });

describe("ratelimitPlugin", () => {
    it("exposes the resolved limiter under ctx.api.ratelimit via the builder chain", async () => {
        expect.assertions(3);

        const limiter = makeLimiter();
        const c = initLunora.dataModel<Record<string, never>>().create();

        const procedure = c.mutation.use(ratelimitPlugin(limiter).middleware!).mutation(async ({ ctx }) => {
            const first = await ctx.api.ratelimit.limit("send", { key: "u-1" });
            const second = await ctx.api.ratelimit.limit("send", { key: "u-1" });
            const third = await ctx.api.ratelimit.limit("send", { key: "u-1" });

            return { firstOk: first.ok, secondOk: second.ok, thirdOk: third.ok };
        });

        // capacity 2 → first two consume, third is denied.
        const result = await procedure.handler({}, {});

        expect(result.firstOk).toBe(true);
        expect(result.secondOk).toBe(true);
        expect(result.thirdOk).toBe(false);
    });

    it("resolves a per-request limiter from ctx when given a function", async () => {
        expect.assertions(1);

        const limiter = makeLimiter();
        const c = initLunora.dataModel<Record<string, never>>().create();

        const procedure = c.query
            .use(async ({ next }) => next({ ctx: { tenantLimiter: limiter } }))
            .use(ratelimitPlugin<{ tenantLimiter: RateLimiter }>((ctx) => ctx.tenantLimiter).middleware!)
            .query(({ ctx }) => {
                return { same: ctx.api.ratelimit === limiter };
            });

        const result = await procedure.handler({}, {});

        expect(result.same).toBe(true);
    });

    it("tags its middleware per-dispatch, so a query charging the limit in its handler stays out of the reactive cache", () => {
        expect.assertions(2);

        const { middleware } = ratelimitPlugin(makeLimiter());
        const c = initLunora.dataModel<Record<string, never>>().create();
        const registered = c.query.use(middleware!).query(() => null) as unknown as { perDispatch?: boolean };

        expect(isPerDispatchMiddleware(middleware)).toBe(true);
        expect(registered.perDispatch).toBe(true);
    });

    it("keeps an existing ctx.api alongside the limiter", async () => {
        expect.assertions(2);

        const limiter = makeLimiter();
        const other = { ping: () => "pong" };
        const c = initLunora.dataModel<Record<string, never>>().create();

        const procedure = c.query
            .use(async ({ next }) => next({ ctx: { api: { other } } }))
            .use(ratelimitPlugin<{ api: { other: typeof other } }>(limiter).middleware!)
            .query(({ ctx }) => {
                return { other: ctx.api.other === other, ratelimit: ctx.api.ratelimit === limiter };
            });

        const result = await procedure.handler({}, {});

        expect(result.other).toBe(true);
        expect(result.ratelimit).toBe(true);
    });

    it("is a middleware-only plugin (no schema extension)", () => {
        expect.assertions(2);

        const plugin = ratelimitPlugin(makeLimiter());

        expect(plugin.extension).toBeUndefined();
        expect(plugin.middleware).toBeTypeOf("function");
    });
});
