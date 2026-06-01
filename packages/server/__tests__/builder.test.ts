import { describe, expect, it, vi } from "vitest";

import { CirrusError, initCirrus, v, ValidationError } from "../src/index.js";

const c = initCirrus.dataModel<Record<string, never>>().create();

describe("builder terminal", () => {
    it("query terminal yields the { args, handler, kind } dispatch shape", async () => {
        expect.assertions(3);

        const list = c.query.input({ limit: v.number() }).query(({ args }) => args.limit * 2);

        expect(list.kind).toBe("query");
        expect(list.args.limit.kind).toBe("number");
        await expect(list.handler({}, { limit: 5 })).resolves.toBe(10);
    });

    it("mutation and action terminals carry their own kind", () => {
        expect.assertions(2);

        const send = c.mutation.input({ text: v.string() }).mutation(({ args }) => args.text);
        const ping = c.action.input({ url: v.string() }).action(({ args }) => args.url);

        expect(send.kind).toBe("mutation");
        expect(ping.kind).toBe("action");
    });

    it("the receiver carries the __cirrusProcedure brand codegen keys off", () => {
        expect.assertions(3);

        expect((c.query as unknown as { __cirrusProcedure: string }).__cirrusProcedure).toBe("query");
        expect((c.mutation as unknown as { __cirrusProcedure: string }).__cirrusProcedure).toBe("mutation");
        expect((c.action as unknown as { __cirrusProcedure: string }).__cirrusProcedure).toBe("action");
    });
});

describe("internal builders", () => {
    it("carry the __cirrusVisibility brand while public builders do not", () => {
        expect.assertions(4);

        expect((c.internalQuery as unknown as { __cirrusVisibility?: string }).__cirrusVisibility).toBe("internal");
        expect((c.internalMutation as unknown as { __cirrusVisibility?: string }).__cirrusVisibility).toBe("internal");
        expect((c.internalAction as unknown as { __cirrusVisibility?: string }).__cirrusVisibility).toBe("internal");
        expect((c.query as unknown as { __cirrusVisibility?: string }).__cirrusVisibility).toBeUndefined();
    });

    it("stamp visibility: internal onto the registered function, preserving kind + the brand across .input()", () => {
        expect.assertions(2);

        const stats = c.internalQuery.input({ limit: v.number() }).query(({ args }) => args.limit);

        expect(stats).toMatchObject({ kind: "query", visibility: "internal" });

        // The brand survives a chained .input() so codegen reads it off the receiver.
        const chained = c.internalQuery.input({ a: v.number() });

        expect((chained as unknown as { __cirrusVisibility?: string }).__cirrusVisibility).toBe("internal");
    });

    it("internal builders still validate and run their handler", async () => {
        expect.assertions(3);

        const purge = c.internalMutation.input({ text: v.string() }).mutation(({ args }) => args.text);

        expect(purge.kind).toBe("mutation");
        await expect(purge.handler({}, { text: "hi" })).resolves.toBe("hi");
        await expect(purge.handler({}, { text: 1 } as unknown as { text: string })).rejects.toBeInstanceOf(ValidationError);
    });
});

describe("builder input accumulation", () => {
    it("merges args across multiple .input() calls", () => {
        expect.assertions(1);

        const function_ = c.query
            .input({ a: v.number() })
            .input({ b: v.string() })
            .query(() => null);

        expect(Object.keys(function_.args).sort()).toEqual(["a", "b"]);
    });

    it("a later .input() wins on key collision", () => {
        expect.assertions(1);

        const function_ = c.query
            .input({ value: v.number() })
            .input({ value: v.string() })
            .query(() => null);

        expect(function_.args.value.kind).toBe("string");
    });

    it("validates args before the handler runs", async () => {
        expect.assertions(2);

        const handler = vi.fn<() => string>(() => "ok");
        const function_ = c.query.input({ limit: v.number() }).query(handler);

        await expect(function_.handler({}, { limit: "five" } as unknown as { limit: number })).rejects.toBeInstanceOf(ValidationError);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("builder middleware", () => {
    it("next({ ctx }) widens the context the handler receives", async () => {
        expect.assertions(1);

        const function_ = c.query.use(async ({ next }) => next({ ctx: { userId: "u1" } })).query(({ ctx }) => ctx.userId);

        await expect(function_.handler({ base: true }, {})).resolves.toBe("u1");
    });

    it("middlewares run in chain order and the handler sees the final ctx", async () => {
        expect.assertions(2);

        const order: string[] = [];

        const function_ = c.query
            .use(async ({ next }) => {
                order.push("a");

                return next({ ctx: { a: 1 } });
            })
            .use(async ({ next }) => {
                order.push("b");

                return next({ ctx: { b: 2 } });
            })
            .query(({ ctx }) => {
                order.push("handler");

                return ctx.a + ctx.b;
            });

        await expect(function_.handler({}, {})).resolves.toBe(3);
        expect(order).toEqual(["a", "b", "handler"]);
    });

    it("calling next() twice throws", async () => {
        expect.assertions(1);

        const function_ = c.query
            .use(async ({ next }) => {
                await next();

                return next();
            })
            .query(() => "ok");

        await expect(function_.handler({}, {})).rejects.toThrow(/next\(\) called multiple times/u);
    });

    it("a middleware that throws aborts before the handler runs", async () => {
        expect.assertions(2);

        const handler = vi.fn<() => string>(() => "secret");

        const function_ = c.query
            .use(async ({ ctx, next }) => {
                if (!(ctx as { user?: string }).user) {
                    throw new CirrusError("UNAUTHORIZED");
                }

                return next();
            })
            .query(handler);

        await expect(function_.handler({}, {})).rejects.toBeInstanceOf(CirrusError);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("builder output", () => {
    it("parses the handler result through the .output() validator, stripping undeclared keys", async () => {
        expect.assertions(1);

        const function_ = c.query.output(v.object({ count: v.number() })).query(() => ({ count: 1, extra: "stripped" }) as { count: number });

        await expect(function_.handler({}, {})).resolves.toEqual({ count: 1 });
    });

    it("rejects when the handler result violates .output()", async () => {
        expect.assertions(1);

        const function_ = c.query.output(v.object({ count: v.number() })).query(() => ({ count: "nope" }) as unknown as { count: number });

        await expect(function_.handler({}, {})).rejects.toBeInstanceOf(ValidationError);
    });

    it(".output() composes with .input() and middleware regardless of chain order", async () => {
        expect.assertions(1);

        const function_ = c.mutation
            .input({ text: v.string() })
            .use(async ({ next }) => next({ ctx: { tag: "m" } }))
            .output(v.object({ echoed: v.string() }))
            .mutation(({ args }) => {
                return { echoed: args.text };
            });

        await expect(function_.handler({}, { text: "hi" })).resolves.toEqual({ echoed: "hi" });
    });
});
