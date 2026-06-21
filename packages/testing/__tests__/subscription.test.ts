import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";

const { mutation, query } = initLunora.dataModel().create();

const schema = defineSchema({
    messages: defineTable({
        author: v.string(),
        body: v.string(),
    }),
    tags: defineTable({
        name: v.string(),
    }),
});

const send = mutation
    .input({ author: v.string(), body: v.string() })
    .mutation(async ({ args, ctx }) => ctx.db.insert("messages", { author: args.author, body: args.body }));

const addTag = mutation.input({ name: v.string() }).mutation(async ({ args, ctx }) => ctx.db.insert("tags", { name: args.name }));

const list = query.query(async ({ ctx }) => ctx.db.query("messages").collect());

const countMessages = query.query(async ({ ctx }) => {
    const rows = await ctx.db.query("messages").collect();

    return rows.length;
});

const open: ReturnType<typeof lunoraTest>[] = [];

const start = (): ReturnType<typeof lunoraTest> => {
    const t = lunoraTest(schema);

    open.push(t);

    return t;
};

describe("harness.subscribe", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("emits the current query result on first next()", async () => {
        expect.assertions(1);

        const t = start();

        await t.mutation(send, { author: "ada", body: "hello" });

        const sub = t.subscribe(list, {});
        const first = await sub.next();

        await sub.return();

        expect(first.value).toHaveLength(1);
    });

    it("emits an updated snapshot after a mutation", async () => {
        expect.assertions(2);

        const t = start();

        const sub = t.subscribe(list, {});

        // Consume initial snapshot (empty db).
        const first = await sub.next();

        expect(first.value).toHaveLength(0);

        // Mutate then consume next snapshot.
        await t.mutation(send, { author: "grace", body: "hi" });

        const second = await sub.next();

        await sub.return();

        expect(second.value).toHaveLength(1);
    });

    it("emits a snapshot after each of multiple mutations", async () => {
        expect.assertions(3);

        const t = start();

        const sub = t.subscribe(countMessages, {});

        // Initial snapshot.
        const s0 = await sub.next();

        expect(s0.value).toBe(0);

        await t.mutation(send, { author: "a", body: "first" });

        const s1 = await sub.next();

        expect(s1.value).toBe(1);

        await t.mutation(send, { author: "b", body: "second" });

        const s2 = await sub.next();

        await sub.return();

        expect(s2.value).toBe(2);
    });

    it("emits after run() as well as mutation()", async () => {
        expect.assertions(2);

        const t = start();

        const sub = t.subscribe(countMessages, {});

        const s0 = await sub.next();

        expect(s0.value).toBe(0);

        await t.run(async (ctx) => ctx.db.insert("messages", { author: "run", body: "direct" }));

        const s1 = await sub.next();

        await sub.return();

        expect(s1.value).toBe(1);
    });

    it("return() stops the subscription and marks it done", async () => {
        expect.assertions(2);

        const t = start();

        const sub = t.subscribe(countMessages, {});

        await sub.next();

        const returnResult = await sub.return();

        expect(returnResult.done).toBe(true);

        // Further calls after return() should also be done.
        const afterReturn = await sub.next();

        expect(afterReturn.done).toBe(true);
    });

    it("subscription is reactive to any mutation, not just ones on the queried table", async () => {
        expect.assertions(2);

        const t = start();

        const sub = t.subscribe(list, {});

        const s0 = await sub.next();

        expect(s0.value).toHaveLength(0);

        // Mutate a DIFFERENT table (tags) — subscription should still re-emit.
        await t.mutation(addTag, { name: "important" });

        const s1 = await sub.next();

        await sub.return();

        // list() query is over messages — still empty — but the subscription re-evaluated.
        expect(s1.value).toHaveLength(0);
    });

    it("works with an inline query function", async () => {
        expect.assertions(2);

        const t = start();

        const sub = t.subscribe(async (ctx) => {
            const rows = await ctx.db.query("messages").collect();

            return rows.length;
        });

        const s0 = await sub.next();

        expect(s0.value).toBe(0);

        await t.mutation(send, { author: "inline", body: "sub" });

        const s1 = await sub.next();

        await sub.return();

        expect(s1.value).toBe(1);
    });

    it("multiple independent subscriptions each receive their own snapshot stream", async () => {
        expect.assertions(4);

        const t = start();

        const subA = t.subscribe(countMessages, {});
        const subB = t.subscribe(list, {});

        const a0 = await subA.next();
        const b0 = await subB.next();

        expect(a0.value).toBe(0);
        expect(b0.value).toHaveLength(0);

        await t.mutation(send, { author: "shared", body: "both see this" });

        const a1 = await subA.next();
        const b1 = await subB.next();

        await subA.return();
        await subB.return();

        expect(a1.value).toBe(1);
        expect(b1.value).toHaveLength(1);
    });

    it("a slow next() after rapid back-to-back mutations resolves to the latest state", async () => {
        expect.assertions(2);

        const t = start();

        const sub = t.subscribe(countMessages, {});

        // Consume the initial empty snapshot.
        const s0 = await sub.next();

        expect(s0.value).toBe(0);

        // Fire several mutations without consuming between them. Each triggers a
        // concurrent re-evaluation; the next() that follows must reflect the most
        // recent committed state (3), never an intermediate/older snapshot — even if
        // the re-evaluation promises settle out of order.
        await t.mutation(send, { author: "a", body: "1" });
        await t.mutation(send, { author: "b", body: "2" });
        await t.mutation(send, { author: "c", body: "3" });

        const latest = await sub.next();

        await sub.return();

        expect(latest.value).toBe(3);
    });

    it("returning one subscription does not affect other active subscriptions", async () => {
        expect.assertions(2);

        const t = start();

        const subA = t.subscribe(countMessages, {});
        const subB = t.subscribe(countMessages, {});

        await subA.next();
        await subB.next();

        // Close subA.
        await subA.return();

        await t.mutation(send, { author: "only b", body: "should see" });

        const b1 = await subB.next();

        await subB.return();

        // subA is done; subB still works.
        const afterReturnResult = await subA.next();

        expect(b1.value).toBe(1);
        expect(afterReturnResult.done).toBe(true);
    });
});
