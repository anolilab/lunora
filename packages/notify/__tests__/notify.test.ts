import type { Notification, Receipt } from "@visulima/notification";
import { describe, expect, it, vi } from "vitest";

import { createNotify } from "../src/notify";
import { routingPushProvider } from "../src/providers";
import { d1SubscriptionStore } from "../src/subscriptions/d1-store";
import { memorySubscriptionStore } from "../src/subscriptions/memory-store";
import type { NotifyDefinition, SubscriptionStore } from "../src/types";
import { fakeD1, mockChatProvider, mockEngine, mockPushProvider, mockThrowingPushProvider } from "./helpers";

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

    it("list strips the delivery secrets (keys / token)", async () => {
        expect.hasAssertions();

        const { push, store } = setup();

        await push.register({ subscription: okSub, userId: "u1" });
        await push.register({ kind: "fcm", token: "device-token-xyz", userId: "u2" });

        for (const surface of [await push.list()]) {
            expect(surface).toHaveLength(2);

            for (const device of surface) {
                // The register() call stored keys/token; the facade must never surface them.
                expect(device).not.toHaveProperty("keys");
                expect(device).not.toHaveProperty("token");
            }

            // The non-secret fields the admin page renders survive the projection.
            expect(surface.find((device) => device.kind === "web-push")).toMatchObject({ endpoint: okSub.endpoint, userId: "u1" });
            expect(surface.find((device) => device.kind === "fcm")).toMatchObject({ kind: "fcm", userId: "u2" });
        }

        // The projection is a facade concern: the raw store row still carries the
        // secrets (only the internal SubscriptionStore, which handlers don't hold,
        // can read them — the broadcast path uses it directly).
        const raw = await store.list();

        expect(raw.find((row) => row.kind === "web-push")?.keys).toStrictEqual({ auth: "a", p256dh: "p" });
        expect(raw.find((row) => row.kind === "fcm")?.token).toBe("device-token-xyz");
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

describe("ctx.push.broadcast fault-tolerance", () => {
    const webPushSub = (suffix: string) => {
        return { endpoint: `https://push.example/${suffix}`, keys: { auth: "a", p256dh: "p" } };
    };

    it("a throwing recipient does not abort the fan-out — others still deliver", async () => {
        expect.hasAssertions();

        const store = memorySubscriptionStore();
        const throwing = mockThrowingPushProvider();
        const { push } = createNotify(baseDefinition(store), {}, { engine: mockEngine({ push: throwing.provider }), silent: true });

        await push.register({ subscription: webPushSub("ok") });
        await push.register({ subscription: webPushSub("throw") });
        await push.register({ subscription: webPushSub("ok2") });

        const result = await push.broadcast({ body: "b", title: "t" });

        // The one throwing send is a single `failed` outcome; the fan-out completes.
        expect(result.total).toBe(3);
        expect(result.sent).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.pruned).toBe(0);
        expect(result.outcomes.filter((outcome) => outcome.status === "failed")).toHaveLength(1);
    });

    it("degrades a recipient whose channel is not configured to failed — others succeed", async () => {
        expect.hasAssertions();

        const store = memorySubscriptionStore();
        // Only the web-push channel is wired; an FCM target hits the router's throw.
        const engine = mockEngine({ push: routingPushProvider({ webPush: mockPushProvider().provider }) });
        const { push } = createNotify(baseDefinition(store), {}, { engine, silent: true });

        await push.register({ subscription: webPushSub("ok") });
        await push.register({ kind: "fcm", token: "device-token-xyz" });

        const result = await push.broadcast({ body: "b" });

        expect(result.total).toBe(2);
        expect(result.sent).toBe(1);
        expect(result.failed).toBe(1);

        const failed = result.outcomes.find((outcome) => outcome.status === "failed");

        expect(failed?.error).toContain("`fcm` channel is configured");
    });

    it("a failing store write during broadcast does not abort the fan-out", async () => {
        expect.hasAssertions();

        // The delivery succeeds but the follow-up `markStatus` UPDATE throws — a
        // transient store error must not reject the fan-out or the accepted send.
        const store = d1SubscriptionStore(fakeD1({ failOn: "UPDATE" }));
        const provider = mockPushProvider();
        const { push } = createNotify(baseDefinition(store), {}, { engine: mockEngine({ push: provider.provider }), silent: true });

        await push.register({ subscription: webPushSub("ok") });

        const result = await push.broadcast({ body: "b" });

        expect(result.total).toBe(1);
        expect(result.sent).toBe(1);
        expect(result.failed).toBe(0);
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

describe("createNotify per-isolate memoization", () => {
    it("builds the engine once per isolate across repeated createNotify calls", () => {
        expect.hasAssertions();

        // No `options.engine` override, so the real engine is built from the config.
        // A counting `webPush` thunk proves `buildEngine`/provider resolution runs
        // exactly once even though `createNotify` is invoked per (simulated) request.
        let builds = 0;
        const env = {};
        const store = memorySubscriptionStore();
        const definition: NotifyDefinition = {
            isLunoraNotify: true,
            store: () => store,
            webPush: () => {
                builds += 1;

                return { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "mailto:a@b.c" };
            },
        };

        createNotify(definition, env, { silent: true });
        createNotify(definition, env, { silent: true });
        createNotify(definition, env, { silent: true });

        expect(builds).toBe(1);
    });

    it("reuses one in-memory fallback store so a registration survives across calls", async () => {
        expect.hasAssertions();

        const env = {};
        const definition: NotifyDefinition = { isLunoraNotify: true, webPush: { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "s" } };

        const first = createNotify(definition, env, { engine: mockEngine({ push: mockPushProvider().provider }), silent: true });

        await first.push.register({ subscription: okSub, userId: "u1" });

        // A second call in the SAME isolate (same definition + env) sees the earlier
        // registration — the fallback store is memoized, not re-created per request.
        const second = createNotify(definition, env, { engine: mockEngine({ push: mockPushProvider().provider }), silent: true });

        await expect(second.push.list()).resolves.toHaveLength(1);
        await expect(second.push.list({ userId: "u1" })).resolves.toHaveLength(1);
    });

    it("warns at most once per isolate when no store is configured", () => {
        expect.hasAssertions();

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const env = {};
        const push = mockPushProvider();
        const definition: NotifyDefinition = { isLunoraNotify: true, webPush: { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "s" } };

        createNotify(definition, env, { engine: mockEngine({ push: push.provider }) });
        createNotify(definition, env, { engine: mockEngine({ push: push.provider }) });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("non-durable in-memory subscription store"));

        warn.mockRestore();
    });
});

describe("delivery observability (ctx.log + ctx.metrics)", () => {
    const setupObs = (options?: { chat?: boolean }) => {
        const store = memorySubscriptionStore();
        const push = mockPushProvider();
        const engine = mockEngine({ chat: options?.chat === true ? mockChatProvider() : undefined, push: push.provider });
        const log = { warn: vi.fn() };
        const metrics = { count: vi.fn() };
        const facade = createNotify(baseDefinition(store, options?.chat), {}, { engine, log, metrics, silent: true });

        return { ...facade, log, metrics, sends: push.sends, store };
    };

    it("counts an accepted push send and never logs a warning", async () => {
        expect.hasAssertions();

        const { log, metrics, push } = setupObs();
        const stored = await push.register({ subscription: okSub, userId: "u1" });

        await push.send(stored.id, { body: "hi", title: "t" });

        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "push", provider: "web-push", status: "accepted" });
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("counts a failed push send with status=failed and logs a warning carrying the ids + error", async () => {
        expect.hasAssertions();

        const { log, metrics, push } = setupObs();
        const stored = await push.register({ subscription: failSub, userId: "u2" });

        await push.send(stored.id, { body: "hi" });

        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "push", provider: "web-push", status: "failed" });
        expect(log.warn).toHaveBeenCalledWith(
            "notify push delivery failed",
            expect.objectContaining({ channel: "push", status: "failed", subscriptionId: stored.id, userId: "u2" }),
        );
    });

    it("counts a gone push send with status=gone and does not log (expected churn)", async () => {
        expect.hasAssertions();

        const { log, metrics, push } = setupObs();
        const stored = await push.register({ subscription: goneSub });

        await push.send(stored.id, { body: "hi" });

        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "push", provider: "web-push", status: "gone" });
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("emits notify.skipped(no-subscriptions-matched) for a broadcast that reaches nobody", async () => {
        expect.hasAssertions();

        const { metrics, push } = setupObs();
        const result = await push.broadcast({ body: "nobody home", title: "t" });

        expect(result.total).toBe(0);
        expect(metrics.count).toHaveBeenCalledWith("notify.skipped", 1, { channel: "push", reason: "no-subscriptions-matched" });
        expect(metrics.count).not.toHaveBeenCalledWith("notify.send", 1, expect.anything());
    });

    it("aggregates broadcast notify.send into one count per status bucket, not per recipient", async () => {
        expect.hasAssertions();

        const { log, metrics, push } = setupObs();
        // 3 accepted, 2 failed, 1 gone — 6 recipients, one kind (web-push).
        for (const suffix of ["ok-1", "ok-2", "ok-3", "fail-1", "fail-2", "gone-1"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            await push.register({ subscription: { endpoint: `https://push.example/${suffix}`, keys: { auth: "a", p256dh: "p" } } });
        }

        await push.broadcast({ body: "drop", title: "News" });

        // ≤ kinds×3 aggregated counts — here exactly 3 (accepted/failed/gone),
        // NOT one per recipient — with the bucket total as the metric value.
        const sendCalls = metrics.count.mock.calls.filter((call) => call[0] === "notify.send");

        expect(sendCalls).toHaveLength(3);
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 3, { channel: "push", provider: "web-push", status: "accepted" });
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 2, { channel: "push", provider: "web-push", status: "failed" });
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "push", provider: "web-push", status: "gone" });
        // Failure LOGS stay per-recipient (the 2 failed; gone/accepted don't warn).
        expect(log.warn).toHaveBeenCalledTimes(2);
    });

    it("counts a configured channel send on notify.send with the receipt's provider", async () => {
        expect.hasAssertions();

        const { metrics, notify } = setupObs({ chat: true });

        await notify.chat({ text: "shipped" });

        // Pin the full dimension set — the channel path is where `provider` comes
        // off the receipt (mock-chat's id), exercising observeSend's provider path.
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "chat", provider: "mock-chat", status: "accepted" });
    });

    it("counts one notify.send per receipt for a multi-channel send, with the unknown fallback", async () => {
        expect.hasAssertions();

        // A fake engine returns receipts directly, including an UNLABELED failure
        // receipt — the only way to reach the `?? "unknown"` fallback, since a real
        // engine receipt always carries channel + provider.
        const receipts: Receipt[] = [
            { channel: "chat", messageId: "m1", provider: "slack", successful: true, timestamp: new Date() },
            { errorMessages: ["boom"], successful: false },
        ];
        const engine = { send: async () => receipts } as unknown as Notification;
        const log = { warn: vi.fn() };
        const metrics = { count: vi.fn() };
        const { notify } = createNotify(baseDefinition(memorySubscriptionStore()), {}, { engine, log, metrics, silent: true });

        const returned = await notify.send({ chat: { text: "hi" } });

        expect(returned).toBe(receipts);
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "chat", provider: "slack", status: "accepted" });
        expect(metrics.count).toHaveBeenCalledWith("notify.send", 1, { channel: "unknown", provider: "unknown", status: "failed" });
        expect(log.warn).toHaveBeenCalledWith(
            "notify unknown delivery failed",
            expect.objectContaining({ channel: "unknown", error: "boom", status: "failed" }),
        );
    });

    it("emits notify.skipped(channel-not-configured) and throws when the channel is unwired", async () => {
        expect.hasAssertions();

        const { metrics, notify } = setupObs();

        await expect(notify.inApp({ body: "x" } as never)).rejects.toThrow("not configured");
        expect(metrics.count).toHaveBeenCalledWith("notify.skipped", 1, { channel: "inapp", reason: "channel-not-configured" });
    });

    it("is a no-op when no log/metrics handles are threaded", async () => {
        expect.hasAssertions();

        const store = memorySubscriptionStore();
        const push = mockPushProvider();
        const engine = mockEngine({ push: push.provider });
        const { push: facade } = createNotify(baseDefinition(store), {}, { engine, silent: true });
        const stored = await facade.register({ subscription: okSub });

        // No observability handles → sends still succeed, nothing throws.
        await expect(facade.send(stored.id, { body: "hi" })).resolves.toMatchObject({ successful: true });
    });
});

describe("web Push SSRF-posture warning (unset allowedPushOrigins)", () => {
    const registerFacade = (definitionOverrides: Partial<NotifyDefinition> = {}) => {
        const store = memorySubscriptionStore();
        const push = mockPushProvider();
        const engine = mockEngine({ push: push.provider });
        // Fresh definition/env identity so the per-isolate one-shot guard starts clean;
        // NOT `silent`, so the warning is allowed to fire.
        const { push: facade } = createNotify({ ...baseDefinition(store), ...definitionOverrides }, {}, { engine });

        return facade;
    };

    it("warns exactly once per isolate when a web-push subscription registers without allowedPushOrigins", async () => {
        expect.hasAssertions();

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        try {
            const facade = registerFacade();

            await facade.register({ subscription: okSub, userId: "u1" });
            await facade.register({ subscription: goneSub, userId: "u2" });

            const originWarnings = warn.mock.calls.filter(([message]) => typeof message === "string" && message.includes("allowedPushOrigins"));

            expect(originWarnings).toHaveLength(1);
        } finally {
            warn.mockRestore();
        }
    });

    it("does not warn for an FCM registration (no client-controlled endpoint) or when allowedPushOrigins is set", async () => {
        expect.hasAssertions();

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        try {
            // FCM tokens carry no endpoint — the origin allowlist doesn't apply.
            await registerFacade().register({ kind: "fcm", token: "device-token-1", userId: "u1" });
            // A configured allowlist is the closed posture — no nudge.
            await registerFacade({ allowedPushOrigins: ["https://push.example"] }).register({ subscription: okSub, userId: "u2" });

            const originWarnings = warn.mock.calls.filter(([message]) => typeof message === "string" && message.includes("allowedPushOrigins"));

            expect(originWarnings).toHaveLength(0);
        } finally {
            warn.mockRestore();
        }
    });
});
