import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { liveQuery } from "../src/live-query";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const listRef = { __lunoraRef: "messages:list" } as FunctionReference;

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
