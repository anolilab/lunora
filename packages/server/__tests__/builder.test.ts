import { DEFER_VALIDATION, installCompiledValidatorMap } from "@lunora/values";
import { describe, expect, it, vi } from "vitest";

import type { Middleware } from "../src/index";
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
    // `.meta()` exists so ONE generic middleware can read the policy it is meant
    // to enforce off `ctx.meta`, instead of the policy being re-parameterised at
    // every `.use()` site. It is deliberately NOT stamped onto the registration:
    // nothing ever read `fn.meta` (not codegen, not the runtime, not studio), and
    // `FunctionRegistryEntry` has no field for it.
    it("does not stamp metadata onto the registration", () => {
        expect.assertions(3);

        const createPin = c.query
            .meta({ rateLimit: "pins/create" })
            .input({ id: v.string() })
            .query(() => 1);

        const watch = c.query.meta({ rateLimit: "pins/watch" }).stream(async function* watchPins() {
            yield 1;
        });

        expect(createPin).not.toHaveProperty("meta");
        expect(watch).not.toHaveProperty("meta");
        expect(c.query.query(() => 1)).not.toHaveProperty("meta");
    });

    // The SAME object reaches every request's `ctx.meta`, so a middleware that
    // writes through it would edit the procedure's module-level static
    // declaration for the rest of the isolate's life. A shallow `Object.freeze`
    // stopped only the top-level assignment; `.meta({ rateLimit: { hits: 0 } })`
    // plus `ctx.meta.rateLimit.hits += 1` is exactly the nested shape the
    // surface invites.
    it("deep-freezes the declaration so a middleware cannot accumulate into it", async () => {
        expect.assertions(3);

        const guarded = c.query
            .meta({ rateLimit: { hits: 0 } })
            .use(async ({ ctx, next }) => {
                const { meta } = ctx as unknown as { meta: { rateLimit: { hits: number } } };

                expect(Object.isFrozen(meta.rateLimit)).toBe(true);

                // Non-strict-mode assignment to a frozen object is a silent
                // no-op; the module is strict, so this throws — either way the
                // shared declaration must not change.
                expect(() => {
                    meta.rateLimit.hits += 1;
                }).toThrow(TypeError);

                return await next({ ctx: ctx as unknown as Record<string, unknown> });
            })
            .query(({ ctx }) => (ctx as unknown as { meta: { rateLimit: { hits: number } } }).meta.rateLimit.hits);

        await expect(guarded.handler({}, {})).resolves.toBe(0);
    });

    // The freeze must land on a COPY. `.meta({ rateLimit: shared })` freezing the
    // caller's `shared` would turn `shared.hits += 1` into a TypeError in
    // unrelated module scope — a side effect on data the caller still owns.
    it("freezes a copy, leaving the caller's own object mutable", () => {
        expect.assertions(4);

        const shared = { hits: 0 };
        const declaration = { rateLimit: shared };

        c.query.meta(declaration).query(() => 1);

        expect(Object.isFrozen(shared)).toBe(false);
        expect(Object.isFrozen(declaration)).toBe(false);

        shared.hits += 1;

        expect(shared.hits).toBe(1);

        // …and the copy did not follow the caller's mutation.
        expect(Object.isFrozen(shared)).toBe(false);
    });

    // A `Map`/`Set` survives `Object.freeze` untouched — its entries live in
    // internal slots — so a middleware could accumulate into the shared
    // declaration through `.set()` / `.add()` for the isolate's life. The clone
    // shadows the mutators so the promise holds for every value kind.
    it("locks a Map/Set in the declaration and copies it away from the caller", async () => {
        expect.assertions(4);

        const seen = new Set<string>(["a"]);
        const limits = new Map<string, number>([["signup", 5]]);

        const guarded = c.query
            .meta({ limits, seen })
            .use(async ({ ctx, next }) => {
                const { meta } = ctx as unknown as { meta: { limits: Map<string, number>; seen: Set<string> } };

                expect(() => meta.seen.add("b")).toThrow(TypeError);
                expect(() => meta.limits.set("signup", 999)).toThrow(TypeError);

                return await next({ ctx: ctx as unknown as Record<string, unknown> });
            })
            .query(({ ctx }) => (ctx as unknown as { meta: { limits: Map<string, number> } }).meta.limits.get("signup"));

        await expect(guarded.handler({}, {})).resolves.toBe(5);

        // The caller's own collections are copies away, still fully usable.
        seen.add("b");

        expect([...seen]).toStrictEqual(["a", "b"]);
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

    // `.meta()` MERGES across calls, so a shared base builder can set defaults a
    // specific procedure then extends. Observable only through `ctx.meta` now
    // that the registration carries nothing.
    it("merges across calls, last write winning per key", async () => {
        expect.assertions(1);

        let seen: unknown;

        const audited = c.query
            .meta({ audit: true, rateLimit: "base" })
            .meta({ rateLimit: "pins/create" })
            .use(async ({ ctx, next }) => {
                seen = ctx.meta;

                return await next({ ctx: ctx as unknown as Record<string, unknown> });
            })
            .query(() => "ok");

        await audited.handler({}, {});

        expect(seen).toStrictEqual({ audit: true, rateLimit: "pins/create" });
    });

    it("exposes the metadata to middleware as ctx.meta inside a streaming procedure", async () => {
        expect.assertions(1);

        let seen: unknown;

        const guarded = c.query
            .meta({ rateLimit: "pins/watch" })
            .use(async ({ ctx, next }) => {
                seen = ctx.meta;

                return await next({ ctx: ctx as unknown as Record<string, unknown> });
            })
            .stream(async function* watchPins() {
                yield "ok";
            });

        const { signal } = new AbortController();
        const iterator = guarded.handler({}, {}, signal)[Symbol.asyncIterator]();

        // The middleware chain is deferred to the first pump (see the `drive()`
        // comment in builder/index.ts) — drive one step to observe ctx.meta.
        await iterator.next();

        expect(seen).toStrictEqual({ rateLimit: "pins/watch" });
    });
});

// `ctx.args` is what makes a payload-gating middleware possible at all: the
// procedure context carries the resolved identity, not the request body, so a
// guard like `@lunora/auth`'s Turnstile/email-gate middlewares — whose whole
// contract is a `(ctx) => ctx.args.<field>` selector — reads its input here or
// nowhere. Without it every such guard rejects every call.
describe("ctx.args (the middleware's view of the call arguments)", () => {
    it("exposes the call arguments to middleware as ctx.args", async () => {
        expect.assertions(2);

        let seen: unknown;

        const guarded = c.mutation
            .input({ message: v.string(), turnstileToken: v.string() })
            .use(async ({ ctx, next }) => {
                // The documented selector shape, verbatim.
                seen = ctx.args.turnstileToken;

                return await next({ ctx: ctx as unknown as Record<string, unknown> });
            })
            .mutation(({ args }) => args.message);

        await expect(guarded.handler({}, { message: "hi", turnstileToken: "tok" })).resolves.toBe("hi");
        expect(seen).toBe("tok");
    });

    // Compile-time half of the same claim, in the shape `@lunora/auth`'s guards
    // are actually written: a factory generic over the ctx whose ONLY inference
    // site is the `.use()` position. If `.use()` did not hand the middleware the
    // args, `(ctx) => ctx.args.token` here would not type-check — which is what
    // both shipped guards' JSDoc tells users to write.
    it("infers ctx.args through a generic selector-taking middleware factory", async () => {
        expect.assertions(2);

        let seen: unknown;

        const selectorGuard =
            <Context>(select: (context: Context) => string | undefined): Middleware<Context, Context> =>
            async ({ ctx, next }) => {
                seen = select(ctx);

                return await next();
            };

        const guarded = c.mutation
            .input({ token: v.string() })
            .use(selectorGuard((ctx) => ctx.args.token))
            .mutation(() => "ok");

        await expect(guarded.handler({}, { token: "tok" })).resolves.toBe("ok");
        expect(seen).toBe("tok");
    });

    // The trust boundary: a security middleware must never be handed input that
    // has not crossed the validators. Undeclared wire keys are dropped by
    // `validateArgs`, so they must not reappear on `ctx.args`.
    it("surfaces the VALIDATED args, not the raw wire object", async () => {
        expect.assertions(1);

        let seen: unknown;

        const guarded = c.mutation
            .input({ email: v.string() })
            .use(async ({ ctx, next }) => {
                seen = ctx.args;

                return await next({ ctx: ctx as unknown as Record<string, unknown> });
            })
            .mutation(() => "ok");

        await guarded.handler({}, { email: "a@b.test", role: "admin" } as unknown as { email: string });

        expect(seen).toStrictEqual({ email: "a@b.test" });
    });

    // `ctx.args` is a frozen COPY, so a middleware cannot rewrite the payload the
    // handler is then dispatched with — a guard that verified `email` must not be
    // able to hand the handler a different one (nor an unrelated middleware do it
    // by accident).
    it("hands middleware a frozen copy the handler does not read back", async () => {
        expect.assertions(4);

        let frozen: boolean | undefined;
        let seen: unknown;

        const guarded = c.mutation
            .input({ email: v.string() })
            .use(async ({ ctx, next }) => {
                seen = ctx.args;
                // Asserted alongside `isFrozen`, which answers `true` for a
                // missing `ctx.args` and would pass vacuously on its own.
                frozen = Object.isFrozen(ctx.args);

                expect(() => {
                    (ctx.args as unknown as { email: string }).email = "evil@b.test";
                }).toThrow(TypeError);

                return await next({ ctx: ctx as unknown as Record<string, unknown> });
            })
            .mutation(({ args }) => args.email);

        await expect(guarded.handler({}, { email: "a@b.test" })).resolves.toBe("a@b.test");
        expect(seen).toStrictEqual({ email: "a@b.test" });
        expect(frozen).toBe(true);
    });

    it("exposes the call arguments to middleware inside a streaming procedure", async () => {
        expect.assertions(1);

        let seen: unknown;

        const guarded = c.query
            .input({ room: v.string() })
            .use(async ({ ctx, next }) => {
                seen = ctx.args.room;

                return await next({ ctx: ctx as unknown as Record<string, unknown> });
            })
            .stream(async function* watchRoom() {
                yield "ok";
            });

        const { signal } = new AbortController();
        // The chain is deferred to the first pump — drive one step to observe it.
        await guarded.handler({}, { room: "lobby" }, signal)[Symbol.asyncIterator]().next();

        expect(seen).toBe("lobby");
    });

    // `.meta()` and `.args` land on the same decorated context; adding one must
    // not have displaced the other.
    it("carries ctx.meta alongside ctx.args", async () => {
        expect.assertions(2);

        let seenArgs: unknown;
        let seenMeta: unknown;

        const guarded = c.mutation
            .input({ email: v.string() })
            .meta({ rateLimit: "signup" })
            .use(async ({ ctx, next }) => {
                seenArgs = ctx.args;
                seenMeta = ctx.meta;

                return await next({ ctx: ctx as unknown as Record<string, unknown> });
            })
            .mutation(() => "ok");

        await guarded.handler({}, { email: "a@b.test" });

        expect(seenArgs).toStrictEqual({ email: "a@b.test" });
        expect(seenMeta).toStrictEqual({ rateLimit: "signup" });
    });

    // Ordering, not decoration: the args reach middleware only after they have
    // been parsed, so a bad payload is rejected before any guard runs.
    it("rejects an invalid payload before the chain runs", async () => {
        expect.assertions(2);

        const ran = vi.fn<() => void>();

        const guarded = c.mutation
            .input({ email: v.string() })
            .use(async ({ ctx, next }) => {
                ran();

                return await next({ ctx: ctx as unknown as Record<string, unknown> });
            })
            .mutation(() => "ok");

        await expect(guarded.handler({}, { email: 42 as unknown as string })).rejects.toThrow(ValidationError);
        expect(ran).not.toHaveBeenCalled();
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
    it("rejects a result carrying keys the .output() validator does not declare", async () => {
        expect.assertions(2);

        // This used to strip `extra` and return `{ count: 1 }`. That is how a
        // column present in a row goes missing from every response the procedure
        // serves, with no error anywhere — the failure this asymmetry exists to
        // stop. On the way IN stripping is right; on the way OUT it deletes data
        // the server meant to send.
        const fn = c.query.output(v.object({ count: v.number() })).query(() => ({ count: 1, extra: "not declared" }) as { count: number });

        await expect(fn.handler({}, {})).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
        // And it names the key, so the fix does not need a debugger.
        await expect(fn.handler({}, {})).rejects.toThrow(/extra/u);
    });

    it("strips undeclared keys when .strip() says the narrowing is deliberate", async () => {
        expect.assertions(1);

        // Trimming an internal field off a row before it reaches a client is a
        // real use of `.output()`. It stays available — it just has to be said,
        // so a reviewer can tell it apart from a forgotten column.
        const fn = c.query.output(v.object({ count: v.number() }).strip()).query(() => ({ count: 1, passwordHash: "secret" }) as { count: number });

        await expect(fn.handler({}, {})).resolves.toEqual({ count: 1 });
    });

    it("leaves .strip() off the original validator when a shared const is narrowed", async () => {
        expect.assertions(2);

        // `.strip()` returns a new validator rather than mutating in place: the
        // shape may be a const reused across procedures, and flipping it there
        // would silently change what every other holder parses.
        const shared = v.object({ count: v.number() });
        const narrowed = shared.strip();

        const strict = c.query.output(shared).query(() => ({ count: 1, extra: "x" }) as { count: number });
        const lenient = c.query.output(narrowed).query(() => ({ count: 1, extra: "x" }) as { count: number });

        await expect(strict.handler({}, {})).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
        await expect(lenient.handler({}, {})).resolves.toEqual({ count: 1 });
    });

    it("re-tags an .output() mismatch as an internal error, not a client 400", async () => {
        expect.assertions(2);

        const fn = c.query.output(v.object({ n: v.number() })).query(() => ({ n: "not-a-number" }) as unknown as { n: number });

        // A contract violation is a server bug: the raw ValidationError (a
        // 400 whose message embeds the offending server-side value) must not
        // escape; `toErrorBody` redacts internal codes at the wire.
        await expect(fn.handler({}, {})).rejects.toBeInstanceOf(LunoraError);
        await expect(fn.handler({}, {})).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
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
