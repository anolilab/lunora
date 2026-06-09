import { initCirrus } from "@cirrus/server";
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
        const c = initCirrus.dataModel<Record<string, never>>().create();

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
        const c = initCirrus.dataModel<Record<string, never>>().create();

        const procedure = c.query
            .use(async ({ next }) => next({ ctx: { tenantLimiter: limiter } }))
            .use(ratelimitPlugin<{ tenantLimiter: RateLimiter }>((ctx) => ctx.tenantLimiter).middleware!)
            .query(({ ctx }) => {
                return { same: ctx.api.ratelimit === limiter };
            });

        const result = await procedure.handler({}, {});

        expect(result.same).toBe(true);
    });

    it("is a middleware-only plugin (no schema extension)", () => {
        expect.assertions(2);

        const plugin = ratelimitPlugin(makeLimiter());

        expect(plugin.extension).toBeUndefined();
        expect(plugin.middleware).toBeTypeOf("function");
    });
});
