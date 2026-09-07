import { Injector, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { FunctionReference, LunoraClient, SubscriptionError } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscription } from "../src/subscription";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const streamRef = { __lunoraRef: "events:stream" } as FunctionReference;
const NEEDS_INJECTOR_RE = /pass `injector` alongside `destroyRef`/u;

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

describe(subscription, () => {
    it("data is undefined before any push, then updates on every push", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { data, error } = subscription(streamRef, { roomId: "r1" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(data()).toBeUndefined();
        expect(error()).toBeUndefined();

        fake.subscriptions[0]?.push([{ id: "1" }]);

        expect(data()).toStrictEqual([{ id: "1" }]);

        fake.subscriptions[0]?.push([{ id: "1" }, { id: "2" }]);

        expect(data()).toStrictEqual([{ id: "1" }, { id: "2" }]);
    });

    it("opens no subscription when args is 'skip'", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { data } = subscription(streamRef, "skip", { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.subscriptions).toHaveLength(0);
        expect(data()).toBeUndefined();
    });

    it("tears down the subscription when the DestroyRef fires", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        subscription(streamRef, { roomId: "r1" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        destroy.destroy();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });

    it("routes a subscription error into the error signal and the onError callback", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const onError = vi.fn<(error: SubscriptionError) => void>();

        const { error } = subscription(streamRef, { roomId: "r1" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef, onError });

        const subError: SubscriptionError = { code: "internal", message: "boom" };

        fake.subscriptions[0]?.emitError(subError);

        expect(onError).toHaveBeenCalledWith(subError);
        expect(error()).toStrictEqual(subError);
    });

    it("clears the error once a healthy value arrives after an error", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { data, error } = subscription(streamRef, { roomId: "r1" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        const subError: SubscriptionError = { code: "internal", message: "transient" };

        fake.subscriptions[0]?.emitError(subError);

        expect(error()).toStrictEqual(subError);

        fake.subscriptions[0]?.push([{ id: "1" }]);

        expect(error()).toBeUndefined();
        expect(data()).toStrictEqual([{ id: "1" }]);
    });

    it("stops updating after teardown", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { data } = subscription(streamRef, { roomId: "r1" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        fake.subscriptions[0]?.push([{ id: "1" }]);

        destroy.destroy();

        fake.subscriptions[0]?.push([{ id: "2" }]);

        expect(data()).toStrictEqual([{ id: "1" }]);
    });
});

describe("subscription — reactive args (plan 340)", () => {
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
        const roomId = signal("r1");

        const { data } = subscription(
            streamRef,
            () => {
                return { roomId: roomId() };
            },
            { client: fake.asClient, destroyRef: destroy.asDestroyRef, injector },
        );

        // The effect's first run is scheduled, not synchronous with creation —
        // flush it before asserting the initial subscription opened.
        TestBed.tick();

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.args).toStrictEqual({ roomId: "r1" });

        fake.subscriptions[0]?.push([{ id: "1" }]);

        expect(data()).toStrictEqual([{ id: "1" }]);

        roomId.set("r2");
        TestBed.tick();

        // The precise ordering proof: the old subscription's `unsubscribe` fires
        // BEFORE the new `subscribe` call.
        expect(events).toStrictEqual(['subscribe:{"roomId":"r1"}', 'unsubscribe:{"roomId":"r1"}', 'subscribe:{"roomId":"r2"}']);

        expect(fake.subscriptions).toHaveLength(2);
        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
        expect(fake.subscriptions[1]?.unsubscribed).toBe(false);

        // The previous args' value does not survive the switch, and a late frame
        // from the torn-down subscription must not leak into the signal.
        expect(data()).toBeUndefined();

        fake.subscriptions[0]?.push([{ id: "stale" }]);

        expect(data()).toBeUndefined();

        fake.subscriptions[1]?.push([{ id: "2" }]);

        expect(data()).toStrictEqual([{ id: "2" }]);
    });

    it("a static args value subscribes exactly once and never resubscribes, even as unrelated signals tick", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const unrelated = signal(0);

        subscription(streamRef, { roomId: "r1" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef, injector });
        TestBed.tick();

        expect(fake.subscriptions).toHaveLength(1);

        unrelated.set(1);
        TestBed.tick();
        unrelated.set(2);
        TestBed.tick();

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);
    });

    it("'skip' opens nothing; switching from 'skip' to real args opens exactly one subscription", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const args = signal<{ roomId: string } | "skip">("skip");

        subscription(streamRef, () => args(), { client: fake.asClient, destroyRef: destroy.asDestroyRef, injector });

        expect(fake.subscriptions).toHaveLength(0);

        args.set({ roomId: "r1" });
        TestBed.tick();

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.args).toStrictEqual({ roomId: "r1" });
    });

    it("clears data and error when the args source switches to 'skip'", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const args = signal<{ roomId: string } | "skip">({ roomId: "r1" });

        const { data, error } = subscription(streamRef, () => args(), { client: fake.asClient, destroyRef: destroy.asDestroyRef, injector });
        TestBed.tick();

        fake.subscriptions[0]?.push([{ id: "1" }]);

        expect(data()).toStrictEqual([{ id: "1" }]);

        args.set("skip");
        TestBed.tick();

        // The effect's cleanup closes the socket, but the signals are what the
        // template renders — leaving them would show a skipped subscription's
        // last payload as if it were live.
        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
        expect(data()).toBeUndefined();
        expect(error()).toBeUndefined();
    });

    it("names `injector` when reactive args are used outside an injection context", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        // No `injector`, and not inside an injection context: Angular's own
        // NG0203 never mentions the option that fixes this, so the adapter
        // re-raises it with the option named.
        expect(() =>
            subscription(
                streamRef,
                () => {
                    return { roomId: "r1" };
                },
                { client: fake.asClient, destroyRef: destroy.asDestroyRef },
            ),
        ).toThrow(NEEDS_INJECTOR_RE);
    });

    it("destroy tears down the reactive-form subscription", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const roomId = signal("r1");

        subscription(
            streamRef,
            () => {
                return { roomId: roomId() };
            },
            { client: fake.asClient, destroyRef: destroy.asDestroyRef, injector },
        );
        TestBed.tick();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        destroy.destroy();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });
});
