import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";

/**
 * The wide-event API (`ctx.span`) under the test harness.
 *
 * These exist because instrumentation that cannot be asserted on does not get
 * maintained: if "did this handler record the right facts?" is only answerable
 * by deploying and squinting at a collector, the attributes rot silently. The
 * harness records what a handler attaches so a test can pin it like any other
 * output.
 */

const { mutation, query } = initLunora.dataModel().create();

const schema = defineSchema({
    orders: defineTable({
        items: v.number(),
        total: v.number(),
    }),
});

/** A handler that records facts about the request as it learns them — the intended shape. */
const checkout = mutation.input({ items: v.number(), total: v.number() }).mutation(async ({ args, ctx }) => {
    ctx.span.setAttributes({ "cart.items": args.items });

    const id = await ctx.db.insert("orders", { items: args.items, total: args.total });

    // Attached AFTER the work, which is the whole point of accumulating across a
    // dispatch rather than passing everything up front.
    ctx.span.setAttribute("order.total", args.total);

    if (args.total > 100) {
        ctx.span.addEvent("order.large", { threshold: 100 });
    }

    return id;
});

/** A handler that swallows an error but leaves evidence of it on the span. */
const resilient = query.query(({ ctx }) => {
    try {
        throw new TypeError("upstream unavailable");
    } catch (error) {
        ctx.span.recordException(error);
    }

    return "fell back";
});

const open: ReturnType<typeof lunoraTest>[] = [];

const start = (): ReturnType<typeof lunoraTest> => {
    const t = lunoraTest(schema);

    open.push(t);

    return t;
};

describe("ctx.span wide events", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("accumulates attributes across a dispatch into one event", async () => {
        expect.assertions(2);

        const t = start();

        await t.mutation(checkout, { items: 3, total: 42 });

        // Both the up-front and the after-the-fact attribute land on the SAME
        // event — the property that lets one record answer questions about a
        // whole request instead of a dozen log lines each answering a fragment.
        expect(t.wideEvent().attributes["cart.items"]).toBe(3);
        expect(t.wideEvent().attributes["order.total"]).toBe(42);
    });

    it("records a span event only when the handler's condition fires", async () => {
        expect.assertions(2);

        const small = start();

        await small.mutation(checkout, { items: 1, total: 10 });

        expect(small.wideEvent().events).toHaveLength(0);

        const large = start();

        await large.mutation(checkout, { items: 1, total: 500 });

        expect(large.wideEvent().events[0]?.name).toBe("order.large");
    });

    it("records a handled exception as the OTel-conventional `exception` event", async () => {
        expect.assertions(3);

        const t = start();

        // The call SUCCEEDS — that is the point. A handled error is invisible
        // otherwise, because nothing re-throws it for a top-level handler to log.
        await expect(t.query(resilient, {})).resolves.toBe("fell back");

        const [event] = t.wideEvent().events;

        expect(event?.name).toBe("exception");
        expect(event?.attributes?.["exception.type"]).toBe("TypeError");
    });

    it("shares one wide event across a composed ctx.runMutation call", async () => {
        expect.assertions(1);

        const t = start();

        const outer = mutation.mutation(async ({ ctx }) => {
            ctx.span.setAttribute("outer", true);

            return ctx.runMutation(checkout, { items: 2, total: 5 });
        });

        await t.mutation(outer, {});

        // A composed call reuses the outer dispatch's context, so its attributes
        // belong to the same request — matching how the real runtime attributes
        // `ctx.log` and `ctx.trace` from an inner function to the outer entrypoint.
        expect(t.wideEvent().attributes).toStrictEqual(expect.objectContaining({ "cart.items": 2, outer: true }));
    });
});
