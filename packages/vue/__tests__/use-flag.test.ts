import type { LunoraClient } from "@lunora/client";
import { describe, expect, it } from "vitest";
import { createApp, effectScope, nextTick, ref } from "vue";

import { LUNORA_INJECTION_KEY } from "../src/lunora-provider";
import { useFlag, useFlags } from "../src/use-flag";
import { createFakeClient } from "./fake-client";

/** The reserved reactive channel every flag read subscribes to. */
const FLAGS_REF = "__lunora_flags__:eval";

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

        expect(fake.subscribeCalls[0]?.args).toStrictEqual({ context: undefined, default: "control", key: "hero", type: "string" });

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
});
