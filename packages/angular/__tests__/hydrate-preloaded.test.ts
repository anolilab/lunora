import type { Preloaded } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { hydratePreloaded } from "../src/hydrate-preloaded";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

describe(hydratePreloaded, () => {
    it("seeds synchronously from preloaded.value then updates on push", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const preloaded: Preloaded<{ messages: string[] }> = {
            __lunoraPreloaded: true,
            args: { channelId: "general" },
            functionPath: "messages:list",
            shardKey: undefined,
            value: { messages: ["a"] },
        };

        const data = hydratePreloaded(preloaded, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(data()).toStrictEqual({ messages: ["a"] });
        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.functionPath).toBe("messages:list");
        expect(fake.subscriptions[0]?.args).toStrictEqual({ channelId: "general" });

        fake.subscriptions[0]?.push({ messages: ["a", "b"] });

        expect(data()).toStrictEqual({ messages: ["a", "b"] });
    });

    it("tears down the subscription when the DestroyRef fires", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const preloaded: Preloaded = {
            __lunoraPreloaded: true,
            args: {},
            functionPath: "x:y",
            shardKey: undefined,
            value: 1,
        };

        hydratePreloaded(preloaded, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        destroy.destroy();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });

    it("forwards the shardKey to the subscription", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const preloaded: Preloaded = {
            __lunoraPreloaded: true,
            args: { room: "r1" },
            functionPath: "x:y",
            shardKey: "r1",
            value: null,
        };

        hydratePreloaded(preloaded, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.subscriptions[0]?.shardKey).toBe("r1");
    });
});
