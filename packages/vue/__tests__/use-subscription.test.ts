import type { FunctionReference } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { useSubscription } from "../src/use-subscription";
import { createFakeClient } from "./fake-client";

const msgRef = { __lunoraRef: "messages:subscribe" } as unknown as FunctionReference;
const args = { channelId: "c1" } as unknown;

// Solid (`createEffect`/`onMount`) and Angular (`shouldOpenSubscription`/
// `PLATFORM_ID`) are SSR-safe by construction — do not port this guard there
// (plan 282 §1/§8).
describe(useSubscription, () => {
    // `useSubscription` gates its live subscription on a browser `window`
    // (SSR guard); the vitest env is `node` (no `window`), so define one for
    // these client-path tests. The dedicated SSR test below removes it to
    // exercise the guard, mirroring `@lunora/vue`'s `use-presence.test.ts`.
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("is undefined until the first server push", () => {
        const fake = createFakeClient();

        const scope = effectScope();
        const { data, error } = scope.run(() => fake.provide(() => useSubscription(msgRef, args)))!;

        expect(data.value).toBeUndefined();
        expect(error.value).toBeUndefined();

        scope.stop();
    });

    it("updates data ref on server push", async () => {
        const fake = createFakeClient();

        const scope = effectScope();
        const { data, error } = scope.run(() => fake.provide(() => useSubscription(msgRef, args)))!;

        fake.push("messages:subscribe", { channelId: "c1" }, [{ id: "1", text: "hello" }]);

        expect(data.value).toStrictEqual([{ id: "1", text: "hello" }]);
        expect(error.value).toBeUndefined();

        scope.stop();
    });

    it("does not subscribe when args is 'skip'", () => {
        const fake = createFakeClient();

        const scope = effectScope();
        scope.run(() => fake.provide(() => useSubscription(msgRef, "skip")))!;

        expect(fake.subscribeCalls).toHaveLength(0);

        scope.stop();
    });

    it("resets data to undefined when reactive args change, until the new subscription pushes", async () => {
        const fake = createFakeClient();
        const scope = effectScope();
        const channelId = ref("c1");
        const { data } = scope.run(() =>
            fake.provide(() =>
                useSubscription(msgRef, () => {
                    return { channelId: channelId.value };
                }),
            ),
        )!;

        fake.push("messages:subscribe", { channelId: "c1" }, [{ id: "1" }]);

        expect(data.value).toStrictEqual([{ id: "1" }]);

        channelId.value = "c2";
        await nextTick();

        expect(fake.subscribeCalls).toHaveLength(2);
        expect(data.value).toBeUndefined();

        scope.stop();
    });

    it("tears down subscription when scope is stopped", () => {
        const fake = createFakeClient();

        const scope = effectScope();
        scope.run(() => fake.provide(() => useSubscription(msgRef, args)));

        expect(fake.subscribeCalls).toHaveLength(1);

        scope.stop();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("preserves the SubscriptionError code on the error ref", () => {
        const fake = createFakeClient();

        const scope = effectScope();
        const { data, error } = scope.run(() => fake.provide(() => useSubscription(msgRef, args)))!;

        // Drive the subscription's error channel with a coded server error.
        fake.subscribeCalls[0]?.options.onError?.({ code: "UNAUTHORIZED", message: "not allowed" });

        expect(error.value).toBeInstanceOf(Error);
        expect(error.value?.message).toBe("not allowed");
        expect((error.value as { code?: string }).code).toBe("UNAUTHORIZED");
        expect(data.value).toBeUndefined();

        scope.stop();
    });

    it("falls back to a plain Error when the SubscriptionError has no code", () => {
        const fake = createFakeClient();

        const scope = effectScope();
        const { error } = scope.run(() => fake.provide(() => useSubscription(msgRef, args)))!;

        fake.subscribeCalls[0]?.options.onError?.({ message: "boom" });

        expect(error.value).toBeInstanceOf(Error);
        expect(error.value?.message).toBe("boom");
        expect((error.value as { code?: string }).code).toBeUndefined();

        scope.stop();
    });

    it("does not subscribe during SSR (no window)", () => {
        const fake = createFakeClient();

        // Simulate the server render: no browser `window`.
        Reflect.deleteProperty(globalThis, "window");

        const scope = effectScope();
        const { data, error } = scope.run(() => fake.provide(() => useSubscription(msgRef, args)))!;

        expect(fake.subscribeCalls).toHaveLength(0);
        expect(data.value).toBeUndefined();
        expect(error.value).toBeUndefined();

        scope.stop();
    });
});
