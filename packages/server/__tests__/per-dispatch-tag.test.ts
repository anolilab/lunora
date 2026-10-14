/**
 * A middleware with a per-dispatch effect must reach the registered function.
 *
 * A procedure's `.use()` chain is part of the registered function's own handler,
 * so it runs INSIDE the dispatch callback the reactive query cache wraps — and a
 * cache HIT answers without invoking that callback. A `.use(rateLimit(...))`
 * query was therefore charged on its first dispatch and on none of the ones the
 * memo served, while every one of those still reached the Durable Object: the
 * requests happened, only the accounting did not.
 *
 * The mark travels middleware → registered function (`perDispatch: true`) →
 * emitted `isCacheableQuery`, which refuses to memoize such a query at all. This
 * file pins the two hops on this side of that chain, including the one that is
 * silent when it breaks: a composer (`protectPublic`, `composePluginMiddleware`)
 * folds a chain into ONE fresh arrow, and a tag it forgets to re-stamp makes the
 * procedure look unmetered.
 */
import { describe, expect, it } from "vitest";

import composeMiddleware from "../src/builder/compose-middleware";
import { isPerDispatchMiddleware, tagPerDispatchMiddleware } from "../src/builder/per-dispatch-tag";
import type { Middleware } from "../src/index";
import { composePluginMiddleware, definePlugin, initLunora, protectPublic } from "../src/index";

const builders = initLunora.dataModel<unknown>().create();

/** Register a query behind `middleware` and hand back the registration the builder produced. */
const registerWith = (middleware: unknown): Record<string, unknown> =>
    (builders.query as unknown as { use: (m: unknown) => { query: (h: () => unknown) => Record<string, unknown> } }).use(middleware).query(() => null);

/** A pass-through that consumes budget — `rateLimit(...)` reduced to what matters here. */
const metering = (): Middleware<unknown, unknown> => tagPerDispatchMiddleware(async ({ next }) => next());

/** A pass-through with no per-dispatch effect — the shape that must stay cacheable. */
const plain =
    (): Middleware<unknown, unknown> =>
    async ({ next }) =>
        next();

describe("per-dispatch middleware tag", () => {
    it("hoists perDispatch onto a registration whose chain carries one", () => {
        expect.assertions(1);

        expect(registerWith(metering()).perDispatch).toBe(true);
    });

    it("leaves the key off a chain with no per-dispatch step", () => {
        expect.assertions(2);

        // ABSENT, not `false`: `isCacheableQuery` reads it off every registration
        // and the overwhelming majority of queries must stay memoizable.
        expect(registerWith(plain())).not.toHaveProperty("perDispatch");
        expect(registerWith(undefined as unknown as Middleware<unknown, unknown>)).not.toHaveProperty("perDispatch");
    });

    it("hoists it onto a stream registration too", () => {
        expect.assertions(1);

        const stream = (
            builders.query as unknown as {
                use: (m: unknown) => { stream: (h: () => AsyncIterable<unknown>) => Record<string, unknown> };
            }
        )
            .use(metering())
            .stream(async function* source() {
                yield 1;
            });

        expect(stream.perDispatch).toBe(true);
    });

    it("re-stamps the mark onto a composed chain", () => {
        expect.assertions(2);

        const composed = composeMiddleware<unknown, unknown>([plain(), metering()]);

        expect(isPerDispatchMiddleware(composed)).toBe(true);
        expect(registerWith(composed).perDispatch).toBe(true);
    });

    it("carries it through a protectPublic bundle", () => {
        expect.assertions(1);

        expect(registerWith(protectPublic({ rateLimit: metering() })).perDispatch).toBe(true);
    });

    it("carries it through a plugin middleware composition", () => {
        expect.assertions(1);

        const plugin = definePlugin("metered", { middleware: metering() });
        const composed = composePluginMiddleware([plugin]);

        expect(registerWith(composed).perDispatch).toBe(true);
    });

    it("leaves a composed chain of plain middlewares unmarked", () => {
        expect.assertions(1);

        expect(isPerDispatchMiddleware(composeMiddleware<unknown, unknown>([plain(), plain()]))).toBe(false);
    });

    it("still runs the middleware it marks", async () => {
        expect.assertions(1);

        // The tag is metadata, not a wrapper: a tagged middleware behaves exactly
        // as it did before, so the chain it sits in is unaffected.
        let charged = 0;
        const chain: Middleware<unknown, unknown> = tagPerDispatchMiddleware(async ({ next }) => {
            charged += 1;

            return next();
        });
        const registered = registerWith(chain) as { handler: (context: unknown, args: Record<string, unknown>) => Promise<unknown> };

        await registered.handler({}, {});

        expect(charged).toBe(1);
    });
});
