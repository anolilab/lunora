import type { LunoraNotify, LunoraPush } from "@lunora/notify";
import { defineNotify } from "@lunora/notify";
import type { Queues, Topics } from "@lunora/queue";
import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraTest } from "../src/index";
import trackHarnesses from "./harness-tracker";

const { action, mutation, query } = initLunora.dataModel().create();

const schema = defineSchema({
    jobs: defineTable({ id: v.string() }),
});

/** The slices of a generated ctx these handlers use; codegen types them in an app. */
type WithQueues = { queues: Queues<"jobs">; topics: Topics<"signups"> };
type WithNotify = { notify: LunoraNotify; push: LunoraPush };

const enqueue = mutation.input({ id: v.string() }).mutation(async ({ args, ctx }) => {
    await ctx.db.insert("jobs", args);
    await (ctx as unknown as WithQueues).queues.jobs.send({ id: args.id }, { delaySeconds: 30 });
});

const enqueueThenFail = mutation.input({}).mutation(async ({ ctx }) => {
    await (ctx as unknown as WithQueues).queues.jobs.send({ id: "lost" });

    throw new Error("boom");
});

const notifyDevice = action.input({ token: v.string() }).action(async ({ args, ctx }) => {
    const { notify, push } = ctx as unknown as WithNotify;
    const device = await push.register({ kind: "fcm", token: args.token, userId: "u1" });

    await push.send(device, { body: "hello", title: "Hi" });
    await notify.send({ push: { body: "direct", to: args.token } });
});

const harnesses = trackHarnesses();

describe("recording ctx.queues / ctx.topics", () => {
    afterEach(() => {
        harnesses.closeAll();
    });

    it("records a mutation's send with its options", async () => {
        expect.assertions(2);

        const t = harnesses.track(lunoraTest(schema));

        await t.mutation(enqueue, { id: "a" });

        expect(t.queues.sent("jobs")).toStrictEqual([{ body: { id: "a" }, delaySeconds: 30 }]);
        expect(t.queues.sent("other")).toStrictEqual([]);
    });

    it("records a batch, a message's delay winning over the batch's", async () => {
        expect.assertions(1);

        const t = harnesses.track(lunoraTest(schema));

        await t.action(async (ctx) => (ctx as unknown as WithQueues).queues.jobs.sendBatch([{ body: 1 }, { body: 2, delaySeconds: 5 }], { delaySeconds: 10 }));

        expect(t.queues.sent("jobs")).toStrictEqual([
            { body: 1, delaySeconds: 10 },
            { body: 2, delaySeconds: 5 },
        ]);
    });

    it("applies the producer's own validation", async () => {
        expect.assertions(2);

        const t = harnesses.track(lunoraTest(schema));

        await expect(t.action(async (ctx) => (ctx as unknown as WithQueues).queues.jobs.send({}, { delaySeconds: 50_000 }))).rejects.toThrow(
            /Cloudflare Queues ceiling/u,
        );
        expect(t.queues.sent("jobs")).toStrictEqual([]);
    });

    it("records a topic publish and shares records with a withIdentity view", async () => {
        expect.assertions(1);

        const t = harnesses.track(lunoraTest(schema));

        await t.withIdentity({ userId: "u1" }).mutation(async (ctx) => (ctx as unknown as WithQueues).topics.signups.publish({ userId: "u1" }));

        expect(t.topics.published("signups")).toStrictEqual([{ body: { userId: "u1" } }]);
    });

    it("keeps queues off query contexts", async () => {
        expect.assertions(1);

        const t = harnesses.track(lunoraTest(schema));

        await expect(
            t.query(
                query.query(({ ctx }) => "queues" in ctx),
                {},
            ),
        ).resolves.toBe(false);
    });

    // A send is not transactional; like production it is not rolled back with the mutation's writes.
    it("keeps a send made before the mutation threw", async () => {
        expect.assertions(2);

        const t = harnesses.track(lunoraTest(schema));

        await expect(t.mutation(enqueueThenFail, {})).rejects.toThrow("boom");
        expect(t.queues.sent("jobs")).toHaveLength(1);
    });
});

describe("recording ctx.notify / ctx.push", () => {
    afterEach(() => {
        harnesses.closeAll();
        vi.restoreAllMocks();
    });

    it("records push sends without touching the network", async () => {
        expect.assertions(3);

        const fetch = vi.spyOn(globalThis, "fetch");
        const t = harnesses.track(lunoraTest(schema));

        await t.action(notifyDevice, { token: "device-1" });

        expect(t.notify.sent("push")).toStrictEqual([
            { channel: "push", payload: { body: "hello", title: "Hi", to: "device-1" } },
            { channel: "push", payload: { body: "direct", to: "device-1" } },
        ]);
        expect(t.notify.sent("chat")).toStrictEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("wires the channels the app's notify config declares, and only those", async () => {
        expect.assertions(3);

        // The app's provider factory is never called: the harness swaps in a recorder.
        const chat = vi.fn<(env: Record<string, unknown>) => unknown>();
        const t = harnesses.track(lunoraTest(schema, { notify: defineNotify({ chat, fcm: () => undefined }) }));

        await t.query(async (ctx) => (ctx as unknown as WithNotify).notify.chat({ text: "hi" }));

        expect(t.notify.sent()).toStrictEqual([{ channel: "chat", payload: { text: "hi" } }]);
        expect(chat).not.toHaveBeenCalled();
        await expect(t.action(async (ctx) => (ctx as unknown as WithNotify).notify.webhook({ body: {}, url: "https://hook.test" }))).rejects.toThrow(
            /"webhook" channel is not configured/u,
        );
    });
});
