import { describe, expect, it } from "vitest";

import { initLunora } from "../src/builder/index";
import type { Middleware } from "../src/builder/types";
import { protectPublic } from "../src/protect-public";

/** A middleware that records its name then forwards the context untouched. */
const trace =
    <Context>(name: string, order: string[]): Middleware<Context, Context> =>
    async ({ next }) => {
        order.push(name);

        return next();
    };

/** A middleware that rejects before reaching the handler (a gate firing). */
const reject =
    <Context>(message: string): Middleware<Context, Context> =>
    () => {
        throw Object.assign(new Error(message), { code: "FORBIDDEN", name: "LunoraError", status: 403 });
    };

describe("protectPublic", () => {
    it("runs rateLimit before captcha before extra middlewares", async () => {
        expect.assertions(1);

        const order: string[] = [];

        const c = initLunora.dataModel<Record<string, never>>().create();
        const procedure = c.query
            .use(
                protectPublic({
                    captcha: trace("captcha", order),
                    rateLimit: trace("rateLimit", order),
                    use: [trace("extra", order)],
                }),
            )
            .query(() => "ok");

        await procedure.handler({}, {});

        expect(order).toEqual(["rateLimit", "captcha", "extra"]);
    });

    it("short-circuits when the rate limit rejects (captcha never runs)", async () => {
        expect.assertions(2);

        const order: string[] = [];

        const c = initLunora.dataModel<Record<string, never>>().create();
        const procedure = c.query
            .use(
                protectPublic({
                    captcha: trace("captcha", order),
                    rateLimit: reject("rate limit exceeded"),
                }),
            )
            .query(() => "ok");

        await expect(procedure.handler({}, {})).rejects.toThrow(/rate limit exceeded/);
        expect(order).toEqual([]);
    });

    it("is a transparent pass-through when no middleware is supplied", async () => {
        expect.assertions(1);

        const c = initLunora.dataModel<Record<string, never>>().create();
        const procedure = c.query.use(protectPublic({})).query(() => "ok");

        await expect(procedure.handler({}, {})).resolves.toBe("ok");
    });

    it("preserves context set upstream and visible downstream", async () => {
        expect.assertions(1);

        const c = initLunora.dataModel<Record<string, never>>().create();
        const procedure = c.query
            .use(async ({ next }) => next({ ctx: { tenant: "acme" } }))
            .use(protectPublic({ rateLimit: trace("rateLimit", []) }))
            .query(({ ctx }) => ctx.tenant);

        await expect(procedure.handler({}, {})).resolves.toBe("acme");
    });
});
