import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import { useSubscription } from "../src/use-subscription";
import { createFakeClient } from "./fake-client";

const msgRef = { __lunoraRef: "messages:subscribe" } as unknown as FunctionReference;
const args = { channelId: "c1" } as unknown;

describe(useSubscription, () => {
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

    it("tears down subscription when scope is stopped", () => {
        const fake = createFakeClient();

        const scope = effectScope();
        scope.run(() => fake.provide(() => useSubscription(msgRef, args)));

        expect(fake.subscribeCalls).toHaveLength(1);

        scope.stop();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });
});
