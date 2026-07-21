import { describe, expect, it, vi } from "vitest";

import { createNotify } from "../src/notify";
import { memorySubscriptionStore } from "../src/subscriptions/memory-store";
import type { NotifyDefinition, SubscriptionStore } from "../src/types";
import { mockChatProvider, mockEngine, mockPushProvider } from "./helpers";

const baseDefinition = (store: SubscriptionStore, chat = false): NotifyDefinition => {
    return {
        isLunoraNotify: true,
        store: () => store,
        webPush: { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "mailto:a@b.c" },
        ...(chat ? { chat: () => mockChatProvider() } : {}),
    };
};

const setup = (options?: { chat?: boolean }) => {
    const store = memorySubscriptionStore();
    const push = mockPushProvider();
    const engine = mockEngine({ chat: options?.chat === true ? mockChatProvider() : undefined, push: push.provider });
    const facade = createNotify(baseDefinition(store, options?.chat), {}, { engine, silent: true });

    return { ...facade, engine, sends: push.sends, store };
};

const okSub = { endpoint: "https://push.example/ok", keys: { auth: "a", p256dh: "p" } };
const goneSub = { endpoint: "https://push.example/gone", keys: { auth: "a", p256dh: "p" } };
const failSub = { endpoint: "https://push.example/fail", keys: { auth: "a", p256dh: "p" } };

describe("ctx.push lifecycle", () => {
    it("registers and lists subscriptions", async () => {
        expect.hasAssertions();

        const { push } = setup();
        const stored = await push.register({ subscription: okSub, userId: "u1" });

        expect(stored.kind).toBe("web-push");
        await expect(push.list()).resolves.toHaveLength(1);
        await expect(push.list({ userId: "u1" })).resolves.toHaveLength(1);
    });

    it("send to a registered subscription marks it ok", async () => {
        expect.hasAssertions();

        const { push, sends, store } = setup();
        const stored = await push.register({ subscription: okSub });
        const receipt = await push.send(stored.id, { body: "hi", title: "t" });

        expect(receipt.successful).toBe(true);
        expect(sends).toHaveLength(1);
        expect(sends[0]).toMatchObject({ body: "hi", title: "t" });
        await expect(store.get(stored.id)).resolves.toMatchObject({ lastStatus: "ok" });
    });

    it("prunes a subscription the push service reports as gone", async () => {
        expect.hasAssertions();

        const { push, store } = setup();
        const stored = await push.register({ subscription: goneSub });
        const receipt = await push.send(stored.id, { body: "hi" });

        expect(receipt.successful).toBe(false);
        await expect(store.get(stored.id)).resolves.toBeUndefined();
    });

    it("throws sending to an unknown subscription id", async () => {
        expect.hasAssertions();

        const { push } = setup();

        await expect(push.send("nope", { body: "x" })).rejects.toThrow(/no registered subscription/u);
    });
});

describe("ctx.push.broadcast", () => {
    it("fans out, counts outcomes and prunes gone subscriptions", async () => {
        expect.hasAssertions();

        const { push, store } = setup();
        await push.register({ subscription: okSub });
        await push.register({ subscription: goneSub });
        await push.register({ subscription: failSub });

        const result = await push.broadcast({ body: "broadcast", title: "News" });

        expect(result.total).toBe(3);
        expect(result.sent).toBe(1);
        expect(result.pruned).toBe(1);
        expect(result.failed).toBe(1);

        // gone pruned, ok + failed remain
        await expect(store.list()).resolves.toHaveLength(2);
    });

    it("respects a userId filter", async () => {
        expect.hasAssertions();

        const { push, sends } = setup();
        await push.register({ subscription: okSub, userId: "u1" });
        await push.register({ subscription: { endpoint: "https://push.example/ok2", keys: { auth: "a", p256dh: "p" } }, userId: "u2" });

        const result = await push.broadcast({ body: "hi" }, { userId: "u1" });

        expect(result.total).toBe(1);
        expect(sends).toHaveLength(1);
    });
});

describe("ctx.notify multi-channel", () => {
    it("delivers a multi-channel message through the engine", async () => {
        expect.hasAssertions();

        const { notify } = setup({ chat: true });
        const receipts = await notify.send({ chat: { text: "hello" }, push: { body: "b", to: "https://push.example/ok-target" } });

        expect(receipts.every((receipt) => receipt.successful)).toBe(true);
    });

    it("throws when using an unconfigured channel", async () => {
        expect.hasAssertions();

        const { notify } = setup();

        await expect(notify.chat({ text: "x" })).rejects.toThrow(/"chat" channel is not configured/u);
    });

    it("exposes the same push object on ctx.notify.push and ctx.push", () => {
        expect.hasAssertions();

        const { notify, push } = setup();

        expect(notify.push).toBe(push);
    });
});

describe("createNotify store fallback", () => {
    it("warns once and uses an in-memory store when none is configured", () => {
        expect.hasAssertions();

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const push = mockPushProvider();
        const definition: NotifyDefinition = { isLunoraNotify: true, webPush: { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "s" } };

        createNotify(definition, {}, { engine: mockEngine({ push: push.provider }) });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("non-durable in-memory subscription store"));

        warn.mockRestore();
    });
});
