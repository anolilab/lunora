import type { LunoraNotify, LunoraPush } from "@lunora/notify";
import { defineNotify } from "@lunora/notify";
import type { Queues } from "@lunora/queue";
import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";
import trackHarnesses from "./harness-tracker";

const { action, mutation, query } = initLunora.dataModel().create();

const schema = defineSchema({
    orders: defineTable({
        item: v.string(),
    }),
});

/** The slices of a generated ctx these handlers use; codegen types them in an app. */
type WithQueues = { queues: Queues<"emails" | "jobs"> };
type WithNotify = { notify: LunoraNotify; push: LunoraPush };

const placeOrder = mutation.input({ item: v.string() }).mutation(async ({ args, ctx }) => {
    const id = await ctx.db.insert("orders", { item: args.item });

    await (ctx as unknown as WithQueues).queues.jobs.send({ id, kind: "fulfil" });

    return id;
});

const placeOrderThenFail = mutation.input({ item: v.string() }).mutation(async ({ args, ctx }) => {
    await ctx.db.insert("orders", { item: args.item });
    await (ctx as unknown as WithQueues).queues.jobs.send({ kind: "fulfil" });

    throw new Error("payment declined");
});

const sendDigest = action.input({ count: v.number() }).action(async ({ args, ctx }) => {
    const messages = Array.from({ length: args.count }, (_, index) => {
        return { body: { index }, delaySeconds: index === 0 ? 5 : undefined };
    });

    await (ctx as unknown as WithQueues).queues.emails.sendBatch(messages, { delaySeconds: 60 });
});

const sendToUndeclared = mutation.input({}).mutation(async ({ ctx }) => {
    await (ctx as unknown as { queues: Queues<"typo"> }).queues.typo.send({});
});

const delayTooLong = mutation.input({}).mutation(async ({ ctx }) => {
    await (ctx as unknown as WithQueues).queues.jobs.send({}, { delaySeconds: 50_000 });
});

const registerDevice = mutation.input({ token: v.string() }).mutation(async ({ args, ctx }) => {
    const stored = await (ctx as unknown as WithNotify).push.register({ kind: "fcm", token: args.token, userId: ctx.auth.userId });

    return stored.id;
});

const notifyUser = action.input({ title: v.string() }).action(async ({ args, ctx }) => {
    const { push } = ctx as unknown as WithNotify;

    return push.broadcast({ body: "your order shipped", title: args.title }, { userId: ctx.auth.userId ?? undefined });
});

const listDevices = query.input({}).query(async ({ ctx }) => (ctx as unknown as WithNotify).push.list());

const postToChat = action.input({ text: v.string() }).action(async ({ args, ctx }) => (ctx as unknown as WithNotify).notify.chat({ text: args.text }));

const notifyDefinition = defineNotify({ fcm: { accessToken: "test", projectId: "test" } });

const harnesses = trackHarnesses();

const start = (options?: Parameters<typeof lunoraTest>[1]): ReturnType<typeof lunoraTest> => harnesses.track(lunoraTest(schema, options));

describe("recording ctx.queues", () => {
    afterEach(() => {
        harnesses.closeAll();
    });

    it("records a send from a mutation under its queue name", async () => {
        expect.assertions(2);

        const t = start({ queues: ["emails", "jobs"] });
        const id = await t.mutation(placeOrder, { item: "lamp" });

        expect(t.queues.sent("jobs")).toStrictEqual([{ body: { id, kind: "fulfil" }, queue: "jobs" }]);
        expect(t.queues.sent("emails")).toStrictEqual([]);
    });

    it("records each message of a batch, a message's own delay winning over the batch's", async () => {
        expect.assertions(1);

        const t = start({ queues: ["emails", "jobs"] });

        await t.action(sendDigest, { count: 2 });

        expect(t.queues.sent()).toStrictEqual([
            { body: { index: 0 }, delaySeconds: 5, queue: "emails" },
            { body: { index: 1 }, delaySeconds: 60, queue: "emails" },
        ]);
    });

    it("keeps a send made by a mutation that then threw, as production does", async () => {
        expect.assertions(3);

        const t = start({ queues: ["jobs"] });

        await expect(t.mutation(placeOrderThenFail, { item: "lamp" })).rejects.toThrow("payment declined");
        // The write rolled back; the send did not.
        await expect(t.run(async (ctx) => ctx.db.query("orders").collect())).resolves.toStrictEqual([]);
        expect(t.queues.sent("jobs")).toHaveLength(1);
    });

    it("applies @lunora/queue's own validation", async () => {
        expect.assertions(3);

        const t = start({ queues: ["jobs"] });

        await expect(t.mutation(delayTooLong, {})).rejects.toThrow(/ceiling of 43200/u);
        await expect(t.mutation(sendToUndeclared, {})).rejects.toThrow(/no queue named "typo" \(known queues: jobs\)/u);
        expect(t.queues.sent()).toStrictEqual([]);
    });

    it("throws on sent() for an undeclared queue, and clear() forgets what was sent", async () => {
        expect.assertions(3);

        const t = start({ queues: ["jobs"] });

        await t.mutation(placeOrder, { item: "lamp" });

        expect(() => t.queues.sent("job")).toThrow(/no such queue — declared: jobs/u);

        t.queues.clear();

        expect(t.queues.sent()).toStrictEqual([]);
        expect(start().queues.sent()).toStrictEqual([]);
    });

    it("shares the record with a withIdentity view", async () => {
        expect.assertions(1);

        const t = start({ queues: ["jobs"] });

        await t.withIdentity({ userId: "u1" }).mutation(placeOrder, { item: "lamp" });

        expect(t.queues.sent("jobs")).toHaveLength(1);
    });
});

describe("recording ctx.notify / ctx.push", () => {
    afterEach(() => {
        harnesses.closeAll();
    });

    it("registers a device and records a broadcast to it instead of sending", async () => {
        expect.assertions(4);

        const t = start({ notify: notifyDefinition });
        const alice = t.withIdentity({ userId: "alice" });

        await alice.mutation(registerDevice, { token: "alice-phone" });
        await t.withIdentity({ userId: "bob" }).mutation(registerDevice, { token: "bob-phone" });

        const result = await alice.action(notifyUser, { title: "Shipped" });

        expect(result.sent).toBe(1);
        expect(t.notify.sent("push")).toStrictEqual([
            { channel: "push", payload: expect.objectContaining({ body: "your order shipped", title: "Shipped", to: "alice-phone" }) },
        ]);
        // Subscriptions live in the harness: a query sees both, with the token stripped as in production.
        await expect(t.query(listDevices, {})).resolves.toHaveLength(2);
        await expect(t.query(listDevices, {})).resolves.not.toContainEqual(expect.objectContaining({ token: expect.anything() }));
    });

    it("refuses a channel the definition does not declare, and records one it does", async () => {
        expect.assertions(3);

        await expect(start({ notify: notifyDefinition }).action(postToChat, { text: "hi" })).rejects.toThrow(/"chat" channel is not configured/u);

        const t = start({
            notify: defineNotify({
                chat: () => {
                    return {};
                },
                fcm: { accessToken: "test", projectId: "test" },
            }),
        });

        await t.action(postToChat, { text: "hi" });

        expect(t.notify.sent("chat")).toStrictEqual([{ channel: "chat", payload: { text: "hi" } }]);
        expect(t.notify.sent("push")).toStrictEqual([]);
    });

    it("never calls the definition's store", async () => {
        expect.assertions(1);

        const t = start({
            notify: defineNotify({
                fcm: { accessToken: "test", projectId: "test" },
                store: () => {
                    throw new Error("the D1 store must not be built in a test");
                },
            }),
        });

        await expect(t.mutation(registerDevice, { token: "phone" })).resolves.toStrictEqual(expect.any(String));
    });

    it("throws naming the option when no notify definition was passed", async () => {
        expect.assertions(1);

        await expect(start().mutation(registerDevice, { token: "phone" })).rejects.toThrow(/pass lunoraTest\(schema, \{ notify \}\)/u);
    });

    it("does not share subscriptions between harnesses built from the same definition", async () => {
        expect.assertions(1);

        // `createNotify` memoizes its store per (definition, env) identity, so share both.
        const env = { REGION: "eu" };

        await start({ env, notify: notifyDefinition }).mutation(registerDevice, { token: "phone" });

        await expect(start({ env, notify: notifyDefinition }).query(listDevices, {})).resolves.toStrictEqual([]);
    });
});
