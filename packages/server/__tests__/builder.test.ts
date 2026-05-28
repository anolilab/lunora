import { describe, expect, test, vi } from "vitest";

import { CirrusError, initCirrus, v, ValidationError } from "../src/index.js";

const c = initCirrus.dataModel<Record<string, never>>().create();

describe("builder terminal", () => {
    test("query terminal yields the { args, handler, kind } dispatch shape", async () => {
        const list = c.query.input({ limit: v.number() }).query(({ args }) => args.limit * 2);

        expect(list.kind).toBe("query");
        expect(list.args.limit.kind).toBe("number");
        await expect(list.handler({}, { limit: 5 })).resolves.toBe(10);
    });

    test("mutation and action terminals carry their own kind", () => {
        const send = c.mutation.input({ text: v.string() }).mutation(({ args }) => args.text);
        const ping = c.action.input({ url: v.string() }).action(({ args }) => args.url);

        expect(send.kind).toBe("mutation");
        expect(ping.kind).toBe("action");
    });

    test("the receiver carries the __cirrusProcedure brand codegen keys off", () => {
        expect((c.query as unknown as { __cirrusProcedure: string }).__cirrusProcedure).toBe("query");
        expect((c.mutation as unknown as { __cirrusProcedure: string }).__cirrusProcedure).toBe("mutation");
        expect((c.action as unknown as { __cirrusProcedure: string }).__cirrusProcedure).toBe("action");
    });
});

describe("internal builders", () => {
    test("carry the __cirrusVisibility brand while public builders do not", () => {
        expect((c.internalQuery as unknown as { __cirrusVisibility?: string }).__cirrusVisibility).toBe("internal");
        expect((c.internalMutation as unknown as { __cirrusVisibility?: string }).__cirrusVisibility).toBe("internal");
        expect((c.internalAction as unknown as { __cirrusVisibility?: string }).__cirrusVisibility).toBe("internal");
        expect((c.query as unknown as { __cirrusVisibility?: string }).__cirrusVisibility).toBeUndefined();
    });

    test("stamp visibility: internal onto the registered function, preserving kind + the brand across .input()", () => {
        const stats = c.internalQuery.input({ limit: v.number() }).query(({ args }) => args.limit);

        expect(stats).toMatchObject({ kind: "query", visibility: "internal" });

        // The brand survives a chained .input() so codegen reads it off the receiver.
        const chained = c.internalQuery.input({ a: v.number() });

        expect((chained as unknown as { __cirrusVisibility?: string }).__cirrusVisibility).toBe("internal");
    });

    test("internal builders still validate and run their handler", async () => {
        const purge = c.internalMutation.input({ text: v.string() }).mutation(({ args }) => args.text);

        expect(purge.kind).toBe("mutation");
        await expect(purge.handler({}, { text: "hi" })).resolves.toBe("hi");
        await expect(purge.handler({}, { text: 1 } as unknown as { text: string })).rejects.toBeInstanceOf(ValidationError);
    });
});

describe("builder input accumulation", () => {
    test("merges args across multiple .input() calls", () => {
        const fn = c.query
            .input({ a: v.number() })
            .input({ b: v.string() })
            .query(() => null);

        expect(Object.keys(fn.args).sort()).toEqual(["a", "b"]);
    });

    test("a later .input() wins on key collision", () => {
        const fn = c.query
            .input({ value: v.number() })
            .input({ value: v.string() })
            .query(() => null);

        expect(fn.args.value.kind).toBe("string");
    });

    test("validates args before the handler runs", async () => {
        const handler = vi.fn(() => "ok");
        const fn = c.query.input({ limit: v.number() }).query(handler);

        await expect(fn.handler({}, { limit: "five" } as unknown as { limit: number })).rejects.toBeInstanceOf(ValidationError);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("builder middleware", () => {
    test("next({ ctx }) widens the context the handler receives", async () => {
        const fn = c.query.use(async ({ next }) => next({ ctx: { userId: "u1" } })).query(({ ctx }) => ctx.userId);

        await expect(fn.handler({ base: true }, {})).resolves.toBe("u1");
    });

    test("middlewares run in chain order and the handler sees the final ctx", async () => {
        const order: string[] = [];

        const fn = c.query
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

        await expect(fn.handler({}, {})).resolves.toBe(3);
        expect(order).toEqual(["a", "b", "handler"]);
    });

    test("calling next() twice throws", async () => {
        const fn = c.query
            .use(async ({ next }) => {
                await next();

                return next();
            })
            .query(() => "ok");

        await expect(fn.handler({}, {})).rejects.toThrow(/next\(\) called multiple times/u);
    });

    test("a middleware that throws aborts before the handler runs", async () => {
        const handler = vi.fn(() => "secret");

        const fn = c.query
            .use(async ({ ctx, next }) => {
                if (!(ctx as { user?: string }).user) {
                    throw new CirrusError("UNAUTHORIZED");
                }

                return next();
            })
            .query(handler);

        await expect(fn.handler({}, {})).rejects.toBeInstanceOf(CirrusError);
        expect(handler).not.toHaveBeenCalled();
    });
});
