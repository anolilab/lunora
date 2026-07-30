import { DEFER_VALIDATION, installCompiledValidatorMap } from "@lunora/values";
import { describe, expect, it, vi } from "vitest";

import { initLunora, LunoraError, v, ValidationError } from "../src/index";

const c = initLunora.dataModel<Record<string, never>>().create();

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

    it("the receiver carries the __lunoraProcedure brand codegen keys off", () => {
        expect.assertions(3);

        expect((c.query as unknown as { __lunoraProcedure: string }).__lunoraProcedure).toBe("query");
        expect((c.mutation as unknown as { __lunoraProcedure: string }).__lunoraProcedure).toBe("mutation");
        expect((c.action as unknown as { __lunoraProcedure: string }).__lunoraProcedure).toBe("action");
    });
});

describe(".meta()", () => {
    // LUNORA_ISSUES #6. Expressing per-procedure policy only as
    // `.use(rateLimit("pins/create"))` makes it executable but not
    // *enumerable* — you cannot generate a rate-limit registry or docs from a
    // middleware chain. `.meta()` puts the same policy back in data.
    it("stamps merged metadata onto the registration", () => {
        expect.assertions(3);

        const createPin = c.query
            .meta({ rateLimit: "pins/create" })
            .input({ id: v.string() })
            .query(() => 1);

        expect(createPin.meta).toStrictEqual({ rateLimit: "pins/create" });

        // Merges, so a shared base builder can set defaults a specific
        // procedure then extends.
        const audited = c.query
            .meta({ audit: true, rateLimit: "base" })
            .meta({ rateLimit: "pins/create" })
            .query(() => 1);

        expect(audited.meta).toStrictEqual({ audit: true, rateLimit: "pins/create" });

        // Absent — not an empty object — when never declared, so the no-meta
        // path stays byte-identical.
        expect(c.query.query(() => 1).meta).toBeUndefined();
    });

    it("exposes the metadata to middleware as ctx.meta", async () => {
        expect.assertions(2);

        // The whole point: middleware reads the policy it is meant to enforce
        // instead of having it hard-wired at each `.use()` site.
        let seen: unknown;

        const guarded = c.query
            .meta({ rateLimit: "pins/create" })
            .use(async ({ ctx, next }) => {
                seen = ctx.meta;

                return await next({ ctx: ctx as unknown as Record<string, unknown> });
            })
            .query(() => "ok");

        await expect(guarded.handler({}, {})).resolves.toBe("ok");
        expect(seen).toStrictEqual({ rateLimit: "pins/create" });
    });
});

describe("compiled-args integration (the codegen AOT seam)", () => {
    it("dispatch validates through a compiled parser installed on the registered function's .args", async () => {
        expect.assertions(2);

        const list = c.query.input({ limit: v.number() }).query(({ args }) => args.limit * 2);
        let fastCalls = 0;

        // `list.args` must be the exact object the handler validates against —
        // installing here and seeing the handler use it proves the codegen wiring
        // (`installCompiledValidatorMap(alias.fn.args, …)`) actually accelerates dispatch.
        installCompiledValidatorMap(list.args, (source) => {
            fastCalls += 1;

            return { limit: source["limit"] };
        });

        await expect(list.handler({}, { limit: 5 })).resolves.toBe(10);
        expect(fastCalls).toBe(1);
    });

    it("falls back to interpreted validation (errors included) when the compiled parser defers", async () => {
        expect.assertions(2);

        const send = c.mutation.input({ text: v.string() }).mutation(({ args }) => args.text);

        installCompiledValidatorMap(send.args, () => DEFER_VALIDATION);

        await expect(send.handler({}, { text: "hi" })).resolves.toBe("hi");
        await expect(send.handler({}, { text: 123 as unknown as string })).rejects.toBeInstanceOf(ValidationError);
    });
});

describe("internal builders", () => {
    it("carry the __lunoraVisibility brand while public builders do not", () => {
        expect.assertions(4);

        expect((c.internalQuery as unknown as { __lunoraVisibility?: string }).__lunoraVisibility).toBe("internal");
        expect((c.internalMutation as unknown as { __lunoraVisibility?: string }).__lunoraVisibility).toBe("internal");
        expect((c.internalAction as unknown as { __lunoraVisibility?: string }).__lunoraVisibility).toBe("internal");
        expect((c.query as unknown as { __lunoraVisibility?: string }).__lunoraVisibility).toBeUndefined();
    });

    it("stamp visibility: internal onto the registered function, preserving kind + the brand across .input()", () => {
        expect.assertions(2);

        const stats = c.internalQuery.input({ limit: v.number() }).query(({ args }) => args.limit);

        expect(stats).toMatchObject({ kind: "query", visibility: "internal" });

        // The brand survives a chained .input() so codegen reads it off the receiver.
        const chained = c.internalQuery.input({ a: v.number() });

        expect((chained as unknown as { __lunoraVisibility?: string }).__lunoraVisibility).toBe("internal");
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

        const fn = c.query
            .input({ a: v.number() })
            .input({ b: v.string() })
            .query(() => null);

        expect(Object.keys(fn.args).toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
    });

    it("a later .input() wins on key collision", () => {
        expect.assertions(1);

        const fn = c.query
            .input({ value: v.number() })
            .input({ value: v.string() })
            .query(() => null);

        expect(fn.args.value.kind).toBe("string");
    });

    it("validates args before the handler runs", async () => {
        expect.assertions(2);

        const handler = vi.fn<() => string>(() => "ok");
        const fn = c.query.input({ limit: v.number() }).query(handler);

        await expect(fn.handler({}, { limit: "five" } as unknown as { limit: number })).rejects.toBeInstanceOf(ValidationError);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("builder middleware", () => {
    it("next({ ctx }) widens the context the handler receives", async () => {
        expect.assertions(1);

        const fn = c.query.use(async ({ next }) => next({ ctx: { userId: "u1" } })).query(({ ctx }) => ctx.userId);

        await expect(fn.handler({ base: true }, {})).resolves.toBe("u1");
    });

    it("middlewares run in chain order and the handler sees the final ctx", async () => {
        expect.assertions(2);

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

    it("calling next() twice throws", async () => {
        expect.assertions(1);

        const fn = c.query
            .use(async ({ next }) => {
                await next();

                return next();
            })
            .query(() => "ok");

        await expect(fn.handler({}, {})).rejects.toThrow(/next\(\) called multiple times/u);
    });

    it("a middleware that throws aborts before the handler runs", async () => {
        expect.assertions(2);

        const handler = vi.fn<() => string>(() => "secret");

        const fn = c.query
            .use(async ({ ctx, next }) => {
                if (!(ctx as { user?: string }).user) {
                    throw new LunoraError("UNAUTHORIZED");
                }

                return next();
            })
            .query(handler);

        await expect(fn.handler({}, {})).rejects.toBeInstanceOf(LunoraError);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("builder output", () => {
    it("parses the handler result through the .output() validator, stripping undeclared keys", async () => {
        expect.assertions(1);

        const fn = c.query.output(v.object({ count: v.number() })).query(() => ({ count: 1, extra: "stripped" }) as { count: number });

        await expect(fn.handler({}, {})).resolves.toEqual({ count: 1 });
    });

    it("rejects when the handler result violates .output()", async () => {
        expect.assertions(1);

        const fn = c.query.output(v.object({ count: v.number() })).query(() => ({ count: "nope" }) as unknown as { count: number });

        await expect(fn.handler({}, {})).rejects.toBeInstanceOf(ValidationError);
    });

    it(".output() composes with .input() and middleware regardless of chain order", async () => {
        expect.assertions(1);

        const fn = c.mutation
            .input({ text: v.string() })
            .use(async ({ next }) => next({ ctx: { tag: "m" } }))
            .output(v.object({ echoed: v.string() }))
            .mutation(({ args }) => {
                return { echoed: args.text };
            });

        await expect(fn.handler({}, { text: "hi" })).resolves.toEqual({ echoed: "hi" });
    });
});

describe("builder x402 (paid procedures)", () => {
    it("stamps x402: { price } onto the registered function", () => {
        expect.assertions(2);

        const list = c.query.x402({ price: "0.01" }).query(() => "ok");

        expect(list.kind).toBe("query");
        expect(list.x402).toEqual({ price: "0.01" });
    });

    it("carries a numeric price and works on mutation + action too", () => {
        expect.assertions(2);

        const send = c.mutation.x402({ price: 0.05 }).mutation(() => "sent");
        const call = c.action.x402({ price: "$0.10" }).action(() => "called");

        expect(send.x402).toEqual({ price: 0.05 });
        expect(call.x402).toEqual({ price: "$0.10" });
    });

    it("leaves x402 absent when the modifier is not used", () => {
        expect.assertions(1);

        const list = c.query.query(() => "ok");

        expect(list.x402).toBeUndefined();
    });

    it("composes with .input()/.output()/.use() in any chain order, preserving validation", async () => {
        expect.assertions(3);

        const fn = c.mutation
            .input({ text: v.string() })
            .x402({ price: "0.02" })
            .use(async ({ next }) => next({ ctx: { tag: "m" } }))
            .output(v.object({ echoed: v.string() }))
            .mutation(({ args }) => {
                return { echoed: args.text };
            });

        expect(fn.x402).toEqual({ price: "0.02" });
        await expect(fn.handler({}, { text: "hi" })).resolves.toEqual({ echoed: "hi" });
        await expect(fn.handler({}, { text: 1 } as unknown as { text: string })).rejects.toBeInstanceOf(ValidationError);
    });

    it("stamps x402 onto a streaming query terminal", () => {
        expect.assertions(2);

        const feed = c.query.x402({ price: "0.001" }).stream(async function* gen() {
            yield 1;
        });

        expect(feed.kind).toBe("stream");
        expect((feed as unknown as { x402?: { price: unknown } }).x402).toEqual({ price: "0.001" });
    });

    it("is public-only: internal builders do not expose .x402()", () => {
        expect.assertions(3);

        expect((c.internalQuery as unknown as { x402?: unknown }).x402).toBeUndefined();
        expect((c.internalMutation as unknown as { x402?: unknown }).x402).toBeUndefined();
        expect((c.internalAction as unknown as { x402?: unknown }).x402).toBeUndefined();
    });
});
