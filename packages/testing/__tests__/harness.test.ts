import { defineSchema, defineTable, mutation, query, v } from "@cirrus/server";
import { describe, expect, it } from "vitest";

import { cirrusTest } from "../src/index";

const schema = defineSchema({
    messages: defineTable({
        author: v.string(),
        body: v.string(),
    }),
});

const send = mutation({
    args: { author: v.string(), body: v.string() },
    handler: async (ctx, args) => ctx.db.insert("messages", { author: args.author, body: args.body }),
});

const list = query({
    args: {},
    handler: async (ctx) => ctx.db.query("messages").collect(),
});

const whoAmI = query({
    args: {},
    handler: (ctx) => ctx.auth.userId,
});

const scheduleSomething = mutation({
    args: {},
    handler: async (ctx) => ctx.scheduler.runAfter(1000, "noop:fn", {}),
});

describe("cirrusTest", () => {
    it("reads back a row written by a mutation", async () => {
        expect.assertions(2);

        const t = cirrusTest(schema);

        await t.mutation(send, { author: "ada", body: "hi" });

        const rows = await t.query(list, {});

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ author: "ada", body: "hi" });
    });

    it("exposes direct db access via run", async () => {
        expect.assertions(1);

        const t = cirrusTest(schema);

        await t.run(async (ctx) => ctx.db.insert("messages", { author: "grace", body: "from run" }));

        const rows = await t.query(list, {});

        expect(rows).toHaveLength(1);
    });

    it("reflects the injected identity via withIdentity and persists writes across the scope", async () => {
        expect.assertions(3);

        const t = cirrusTest(schema);

        await expect(t.query(whoAmI, {})).resolves.toBeNull();

        const scoped = t.withIdentity({ userId: "u1" });

        await expect(scoped.query(whoAmI, {})).resolves.toBe("u1");

        // A write under the scoped accessor must be visible from the base harness
        // (they share one in-memory SQLite handle).
        await scoped.mutation(send, { author: "u1", body: "scoped write" });

        const rows = await t.query(list, {});

        expect(rows).toHaveLength(1);
    });

    it("runs an inline query function", async () => {
        expect.assertions(1);

        const t = cirrusTest(schema);

        await t.mutation(send, { author: "ada", body: "one" });
        await t.mutation(send, { author: "ada", body: "two" });

        const count = await t.query(async (ctx) => {
            const rows = await ctx.db.query("messages").collect();

            return rows.length;
        });

        expect(count).toBe(2);
    });

    it("throws a clear error when a handler touches a stubbed surface", async () => {
        expect.assertions(1);

        const t = cirrusTest(schema);

        await expect(t.mutation(scheduleSomething, {})).rejects.toThrow("ctx.scheduler is not available in the in-memory @cirrus/testing harness (v1)");
    });
});
