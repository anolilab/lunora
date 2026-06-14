import { defineSchema, defineTable, internalMutation, mutation, query, v } from "@cirrus/server";
import { afterEach, describe, expect, it } from "vitest";

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

const internalSend = internalMutation({
    args: { author: v.string(), body: v.string() },
    handler: async (ctx, args) => ctx.db.insert("messages", { author: args.author, body: args.body }),
});

// A public mutation that routes through ctx.runMutation to the internal one,
// modelling prod's trusted system dispatch (where internals are reachable).
const sendViaInternal = mutation({
    args: { author: v.string(), body: v.string() },
    handler: async (ctx, args) => ctx.runMutation(internalSend, { author: args.author, body: args.body }),
});

// Track every harness so each test's in-memory SQLite handle is closed in
// afterEach — exercising the harness `close()` API and leaking no native handles.
const open: ReturnType<typeof cirrusTest>[] = [];

const start = (): ReturnType<typeof cirrusTest> => {
    const t = cirrusTest(schema);

    open.push(t);

    return t;
};

describe("cirrusTest", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("reads back a row written by a mutation", async () => {
        expect.assertions(2);

        const t = start();

        await t.mutation(send, { author: "ada", body: "hi" });

        const rows = await t.query(list, {});

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ author: "ada", body: "hi" });
    });

    it("exposes direct db access via run", async () => {
        expect.assertions(1);

        const t = start();

        await t.run(async (ctx) => ctx.db.insert("messages", { author: "grace", body: "from run" }));

        const rows = await t.query(list, {});

        expect(rows).toHaveLength(1);
    });

    it("reflects the injected identity via withIdentity and persists writes across the scope", async () => {
        expect.assertions(3);

        const t = start();

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

        const t = start();

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

        const t = start();

        await expect(t.mutation(scheduleSomething, {})).rejects.toThrow("ctx.scheduler is not available in the in-memory @cirrus/testing harness (v1)");
    });

    it("rejects an internal function called on the external surface", async () => {
        expect.assertions(2);

        const t = start();

        await expect(async () => t.mutation(internalSend, { author: "ada", body: "leak" })).rejects.toThrow(
            "is an internal function — it is unreachable from the external RPC boundary in production",
        );

        // The rejected call must not have written anything.
        const rows = await t.query(list, {});

        expect(rows).toHaveLength(0);
    });

    it("allows an internal function called through ctx.runMutation", async () => {
        expect.assertions(2);

        const t = start();

        await t.mutation(sendViaInternal, { author: "grace", body: "via internal" });

        const rows = await t.query(list, {});

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ author: "grace", body: "via internal" });
    });

    it("still runs a public function on the external surface", async () => {
        expect.assertions(1);

        const t = start();

        await t.mutation(send, { author: "ada", body: "public ok" });

        const rows = await t.query(list, {});

        expect(rows).toHaveLength(1);
    });
});
