import type { FunctionReference, SubscriptionError } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { subscription } from "../src/subscription";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const streamRef = { __lunoraRef: "events:stream" } as FunctionReference;

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
        expect(error()).toBeInstanceOf(Error);
        expect(error()?.message).toBe("boom");
    });

    it("clears the error once a healthy value arrives after an error", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { data, error } = subscription(streamRef, { roomId: "r1" }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        fake.subscriptions[0]?.emitError({ code: "internal", message: "transient" });

        expect(error()).toBeInstanceOf(Error);

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
