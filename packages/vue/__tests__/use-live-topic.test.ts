import type { LiveStreamSubscribeError, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, reactive, ref } from "vue";

import type { UseLiveTopicResult } from "../src/use-live-topic";
import { useLiveTopic } from "../src/use-live-topic";

interface Subscription {
    options: SubscribeLiveTopicOptions;
    unsubscribe: Mock<() => void>;
}

const subscriptions = vi.hoisted(() => [] as Subscription[]);

// Only `subscribeLiveTopic` is replaced; the rest of `@lunora/client` stays real.
vi.mock(import("@lunora/client"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        subscribeLiveTopic: vi.fn<(options: SubscribeLiveTopicOptions) => () => void>((options) => {
            const unsubscribe = vi.fn<() => void>();

            subscriptions.push({ options, unsubscribe });

            return unsubscribe;
        }),
    };
});

const URL = "/live/posts/connect";

/** The subscription opened by the `index`-th call to `subscribeLiveTopic`. */
const subscriptionAt = (index: number): Subscription => {
    const subscription = subscriptions[index];

    if (subscription === undefined) {
        throw new Error(`no subscription at index ${String(index)}`);
    }

    return subscription;
};

/** Run `useLiveTopic` inside a fresh effect scope, so the test can dispose it like a component unmount. */
const mount = (options: Parameters<typeof useLiveTopic>[0]) => {
    const scope = effectScope();
    const result: UseLiveTopicResult = scope.run(() => useLiveTopic(options))!;

    return { result, scope };
};

describe(useLiveTopic, () => {
    // `useLiveTopic` only subscribes in a browser (the SSR guard keys on `window`), and
    // the vitest env here is `node`, so define one for the client-path tests.
    beforeEach(() => {
        subscriptions.length = 0;
        vi.mocked(subscribeLiveTopic).mockClear();
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("subscribes on setup with the connection options", () => {
        expect.hasAssertions();

        mount({ topic: "post:1", url: URL, withCredentials: true });

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(1);
        expect(subscribeLiveTopic).toHaveBeenCalledWith(expect.objectContaining({ topic: "post:1", url: URL, withCredentials: true }));
    });

    it("unsubscribes when the scope is disposed", () => {
        expect.hasAssertions();

        const { scope } = mount({ topic: "post:1", url: URL });
        const { unsubscribe } = subscriptionAt(0);

        expect(unsubscribe).not.toHaveBeenCalled();

        scope.stop();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("resolves ref and getter fields, and resubscribes when a reactive topic changes", async () => {
        expect.hasAssertions();

        const topic = ref("a");
        const { result } = mount({ topic, url: () => URL });

        expect(subscriptionAt(0).options.topic).toBe("a");

        subscriptionAt(0).options.onEvent?.({ from: "a" });

        expect(result.lastEvent.value).toStrictEqual({ from: "a" });

        topic.value = "b";
        await nextTick();

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(2);
        expect(subscriptionAt(0).unsubscribe).toHaveBeenCalledTimes(1);
        expect(subscriptionAt(1).options.topic).toBe("b");
        expect(result.lastEvent.value).toBeUndefined();
    });

    it("does not resubscribe when only a callback changes, and calls the latest one", async () => {
        expect.hasAssertions();

        const firstOnEvent = vi.fn<(payload: unknown) => void>();
        const secondOnEvent = vi.fn<(payload: unknown) => void>();
        const options = reactive<Parameters<typeof useLiveTopic>[0]>({ onEvent: firstOnEvent, topic: "a", url: URL });

        mount(options);
        options.onEvent = secondOnEvent;
        await nextTick();

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(1);

        subscriptionAt(0).options.onEvent?.({ n: 1 });

        expect(firstOnEvent).not.toHaveBeenCalled();
        expect(secondOnEvent).toHaveBeenCalledWith({ n: 1 });
    });

    it("exposes the last delivered payload as lastEvent", () => {
        expect.hasAssertions();

        const { result } = mount({ topic: "a", url: URL });

        expect(result.lastEvent.value).toBeUndefined();

        subscriptionAt(0).options.onEvent?.({ id: 1 });

        expect(result.lastEvent.value).toStrictEqual({ id: 1 });

        subscriptionAt(0).options.onEvent?.({ id: 2 });

        expect(result.lastEvent.value).toStrictEqual({ id: 2 });
    });

    it("sets error and calls onError when the shard refuses the subscription", () => {
        expect.hasAssertions();

        const onError = vi.fn<(error: LiveStreamSubscribeError) => void>();
        const { result } = mount({ onError, topic: "a", url: URL });
        const refusal: LiveStreamSubscribeError = { status: 403, subscriptionId: "sub-1", topic: "a" };

        expect(result.error.value).toBeUndefined();

        subscriptionAt(0).options.onError?.(refusal);

        expect(result.error.value).toStrictEqual(refusal);
        expect(onError).toHaveBeenCalledWith(refusal);
    });

    it("does nothing during SSR: no subscription, and the refs stay at their initial values", () => {
        expect.hasAssertions();

        Reflect.deleteProperty(globalThis, "window");

        const { result } = mount({ topic: "a", url: URL });

        expect(subscribeLiveTopic).not.toHaveBeenCalled();
        expect(result.lastEvent.value).toBeUndefined();
        expect(result.error.value).toBeUndefined();
    });
});
