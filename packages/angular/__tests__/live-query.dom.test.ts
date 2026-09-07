import { Injector, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { FunctionReference, LunoraClient, SubscriptionError } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveQuery } from "../src/live-query";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const listRef = { __lunoraRef: "messages:list" } as FunctionReference;

/**
 * Wraps `client.subscribe` with an order log of `subscribe:<args>` /
 * `unsubscribe:<args>` entries, in call order — the direct way to prove
 * teardown-before-reopen (not just "eventually true after the fact"), without
 * touching the shared `fake-client.ts` helper.
 */
const trackSubscribeOrder = (client: LunoraClient): string[] => {
    const events: string[] = [];
    const original = client.subscribe.bind(client);

    vi.spyOn(client, "subscribe").mockImplementation((...callArgs: Parameters<typeof original>) => {
        const argsKey = JSON.stringify(callArgs[1]);

        events.push(`subscribe:${argsKey}`);

        const unsubscribe = original(...callArgs);

        return () => {
            events.push(`unsubscribe:${argsKey}`);
            unsubscribe();
        };
    });

    return events;
};

describe(liveQuery, () => {
    it("reads undefined until the first frame, then updates on every push", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const data = liveQuery(listRef, { channelId: "channel:demo" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef, shardKey: "channel:demo" });

        expect(data()).toBeUndefined();
        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.shardKey).toBe("channel:demo");
        expect(fake.subscriptions[0]?.args).toStrictEqual({ channelId: "channel:demo" });

        fake.subscriptions[0]?.push({ messages: ["a"] });

        expect(data()).toStrictEqual({ messages: ["a"] });

        fake.subscriptions[0]?.push({ messages: ["a", "b"] });

        expect(data()).toStrictEqual({ messages: ["a", "b"] });
    });

    it("opens no subscription when args is 'skip'", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const data = liveQuery(listRef, "skip", { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.subscriptions).toHaveLength(0);
        expect(data()).toBeUndefined();
    });

    it("tears down the subscription when the DestroyRef fires", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        liveQuery(listRef, { channelId: "channel:demo" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        destroy.destroy();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });

    it("forwards a post-attach subscription error to onError", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const onError = vi.fn<(error: SubscriptionError) => void>();

        liveQuery(listRef, { channelId: "channel:demo" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef, onError });

        const error: SubscriptionError = { code: "internal", message: "boom" };

        fake.subscriptions[0]?.emitError(error);

        expect(onError).toHaveBeenCalledWith(error);
    });

    it("stops updating the signal after teardown", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const data = liveQuery(listRef, { channelId: "channel:demo" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        fake.subscriptions[0]?.push({ messages: ["a"] });

        expect(data()).toStrictEqual({ messages: ["a"] });

        destroy.destroy();

        // A late push from an in-flight frame must not reach the signal.
        fake.subscriptions[0]?.push({ messages: ["a", "b"] });

        expect(data()).toStrictEqual({ messages: ["a"] });
    });
});

describe("liveQuery — reactive args (plan 340)", () => {
    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    });

    afterEach(() => {
        TestBed.resetTestingModule();
    });

    it("tears the old subscription down BEFORE opening the new one when the args source changes, and the new subscription gets the new args", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const events = trackSubscribeOrder(fake.asClient);
        const injector = TestBed.inject(Injector);
        const channelId = signal("general");

        // No `TestBed.runInInjectionContext` wrapper — this is the documented
        // "outside an injection context" convention (explicit `client` +
        // `destroyRef`, e.g. `ngOnInit`); the caller supplies `injector`
        // explicitly instead, exactly like Angular's own `effect({ injector })`.
        const data = liveQuery(
            listRef,
            () => {
                return { channelId: channelId() };
            },
            { client: fake.asClient, destroyRef: destroy.asDestroyRef, injector },
        );

        // The effect's first run is scheduled, not synchronous with creation —
        // flush it before asserting the initial subscription opened.
        TestBed.tick();

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.args).toStrictEqual({ channelId: "general" });

        fake.subscriptions[0]?.push({ messages: ["hi"] });

        expect(data()).toStrictEqual({ messages: ["hi"] });

        channelId.set("random");
        TestBed.tick();

        // The precise ordering proof: the old subscription's `unsubscribe` fires
        // BEFORE the new `subscribe` call — not just "both eventually happened".
        expect(events).toStrictEqual(['subscribe:{"channelId":"general"}', 'unsubscribe:{"channelId":"general"}', 'subscribe:{"channelId":"random"}']);

        expect(fake.subscriptions).toHaveLength(2);
        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
        expect(fake.subscriptions[1]?.unsubscribed).toBe(false);
        expect(fake.subscriptions[1]?.args).toStrictEqual({ channelId: "random" });

        // The previous args' value does not survive the switch, and a late frame
        // from the torn-down subscription must not leak into the signal.
        expect(data()).toBeUndefined();

        fake.subscriptions[0]?.push({ messages: ["stale"] });

        expect(data()).toBeUndefined();

        fake.subscriptions[1]?.push({ messages: ["fresh"] });

        expect(data()).toStrictEqual({ messages: ["fresh"] });
    });

    it("a static args value subscribes exactly once and never resubscribes, even as unrelated signals tick", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const unrelated = signal(0);

        // A plain object — the static form takes no `effect()` at all, so it
        // cannot re-track anything. `injector` is harmless-but-unused here.
        liveQuery(listRef, { channelId: "general" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef, injector });
        TestBed.tick();

        expect(fake.subscriptions).toHaveLength(1);

        unrelated.set(1);
        TestBed.tick();
        unrelated.set(2);
        TestBed.tick();

        // If the static path were accidentally routed through `effect()`, ticks
        // would eventually resubscribe; they must be a no-op here.
        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);
    });

    it("'skip' opens nothing; switching from 'skip' to real args opens exactly one subscription", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const args = signal<{ channelId: string } | "skip">("skip");

        liveQuery(listRef, () => args(), { client: fake.asClient, destroyRef: destroy.asDestroyRef, injector });

        expect(fake.subscriptions).toHaveLength(0);

        args.set({ channelId: "general" });
        TestBed.tick();

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.args).toStrictEqual({ channelId: "general" });
    });

    it("destroy tears down the reactive-form subscription", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const channelId = signal("general");

        liveQuery(
            listRef,
            () => {
                return { channelId: channelId() };
            },
            { client: fake.asClient, destroyRef: destroy.asDestroyRef, injector },
        );
        TestBed.tick();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        destroy.destroy();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });
});
