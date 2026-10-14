import type { LunoraClient } from "@lunora/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, effectScope, nextTick, ref } from "vue";

import { LUNORA_INJECTION_KEY } from "../src/lunora-provider";
import { useFlag, useFlags } from "../src/use-flag";
import { createFakeClient } from "./fake-client";

/** The reserved reactive channel every flag read subscribes to. */
const FLAGS_REF = "__lunora_flags__:eval";

// `useFlag`/`useFlags` gate their subscription on a browser `window` (SSR guard);
// the vitest env is `node` (no `window`), so define one for the client-path tests.
// The SSR block at the bottom deletes it again to assert the guarded path.
/* eslint-disable vitest/require-top-level-describe -- the `window` stub is shared by every describe in this file, so it belongs at file scope */
beforeAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
});
/* eslint-enable vitest/require-top-level-describe */

describe(useFlag, () => {
    it("subscribes on the reserved flags channel — never HTTP-fetches — holds the default, then resolves on push", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const flag = scope.run(() => fake.provide(() => useFlag("dark-mode", false)))!;

        // `{ immediate: true }` opens the subscription synchronously on setup.
        expect(fake.subscribeCalls).toHaveLength(1);
        expect(fake.subscribeCalls[0]?.functionPath).toBe(FLAGS_REF);
        expect(flag.value).toBe(false);

        fake.subscribeCalls[0]?.callback(true);

        expect(flag.value).toBe(true);

        scope.stop();
    });

    it("sends the flag key, inferred type, and default as subscribe args", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const flag = scope.run(() => fake.provide(() => useFlag("hero", "control")))!;

        expect(fake.subscribeCalls[0]?.args).toStrictEqual({ default: "control", key: "hero", type: "string" });

        fake.subscribeCalls[0]?.callback("variant-b");

        expect(flag.value).toBe("variant-b");

        scope.stop();
    });

    it("re-subscribes and resets to the default when a reactive key changes", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const key = ref("alpha");
        const scope = effectScope();
        const flag = scope.run(() => fake.provide(() => useFlag(key, false)))!;

        fake.subscribeCalls[0]?.callback(true);

        expect(flag.value).toBe(true);

        // A different key is a different flag — the prior `true` must not leak.
        key.value = "beta";
        await nextTick();

        expect(fake.subscribeCalls).toHaveLength(2);
        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(flag.value).toBe(false);

        scope.stop();
    });

    it("fails open — a thrown subscribe keeps the default", () => {
        expect.hasAssertions();

        const app = createApp({});

        app.provide(LUNORA_INJECTION_KEY, {
            subscribe: () => {
                throw new Error("socket closed");
            },
        } as unknown as LunoraClient);

        const scope = effectScope();
        const flag = scope.run(() => app.runWithContext(() => useFlag("dark-mode", false)))!;

        expect(flag.value).toBe(false);

        scope.stop();
    });

    it("fails open on a server-pushed evaluation error — resolves back to the default", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const flag = scope.run(() => fake.provide(() => useFlag("hero", "control")))!;

        fake.subscribeCalls[0]?.callback("variant-b");

        expect(flag.value).toBe("variant-b");

        // Regression: the provider starts failing mid-session. Without an `onError`
        // sink the composable kept serving `variant-b` — an experiment arm that
        // should have been rolled back — instead of the documented fail-open default.
        fake.subscribeCalls[0]?.options.onError?.({ message: "provider unavailable" });

        expect(flag.value).toBe("control");

        scope.stop();
    });

    it("tears down the subscription when the effect scope stops", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();

        scope.run(() => fake.provide(() => useFlag("dark-mode", false)));

        expect(fake.subscribeCalls).toHaveLength(1);

        scope.stop();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });
});

describe("useFlag/useFlags during SSR", () => {
    // Regression: both composables subscribed from a `{ immediate: true }` watch
    // body, which fires synchronously inside `setup()` during `renderToString`.
    // With no unmount on the server `onCleanup` never runs and the effect scope is
    // never stopped, so each rendered request stranded a live subscription and its
    // socket for the life of the worker.
    beforeAll(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    afterAll(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    it("opens no subscription and holds the default", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const flag = scope.run(() => fake.provide(() => useFlag("dark-mode", false)))!;
        const many = scope.run(() => fake.provide(() => useFlags({ "dark-mode": false, "page-size": 10 })))!;

        expect(fake.subscribeCalls).toHaveLength(0);
        expect(flag.value).toBe(false);
        expect(many.value).toStrictEqual({ "dark-mode": false, "page-size": 10 });

        scope.stop();
    });
});

describe(useFlags, () => {
    it("opens one subscription per key and resolves each independently", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const flags = scope.run(() => fake.provide(() => useFlags({ "dark-mode": false, "page-size": 10 })))!;

        expect(fake.subscribeCalls).toHaveLength(2);
        expect(flags.value).toStrictEqual({ "dark-mode": false, "page-size": 10 });

        // Fan distinct values to each per-key subscription via its subscribe-time args.
        fake.subscribeCalls.find((call) => call.args["key"] === "dark-mode")?.callback(true);
        fake.subscribeCalls.find((call) => call.args["key"] === "page-size")?.callback(50);

        expect(flags.value).toStrictEqual({ "dark-mode": true, "page-size": 50 });

        scope.stop();
    });

    it("fails open per key on a server-pushed evaluation error", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const flags = scope.run(() => fake.provide(() => useFlags({ "dark-mode": false, "page-size": 10 })))!;

        const dark = fake.subscribeCalls.find((call) => call.args["key"] === "dark-mode");

        dark?.callback(true);
        fake.subscribeCalls.find((call) => call.args["key"] === "page-size")?.callback(50);

        expect(flags.value).toStrictEqual({ "dark-mode": true, "page-size": 50 });

        // Only the failing flag reverts; the healthy one keeps its resolved value.
        dark?.options.onError?.({ message: "provider unavailable" });

        expect(flags.value).toStrictEqual({ "dark-mode": false, "page-size": 50 });

        scope.stop();
    });
});
