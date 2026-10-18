import type { LiveStreamSubscribeError, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { get, writable } from "svelte/store";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { liveTopic } from "../src/live-topic";

vi.mock(import("@lunora/client"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, subscribeLiveTopic: vi.fn<typeof subscribeLiveTopic>() };
});

const subscribeMock = vi.mocked(subscribeLiveTopic);

// `liveTopic` opens only in a browser, and the vitest env is `node`: define a
// `window` for the client-path tests, as `subscription.test.ts` does.
/* eslint-disable vitest/require-top-level-describe -- the `window` stub is shared by every describe in this file, so it belongs at file scope */
beforeAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
});
/* eslint-enable vitest/require-top-level-describe */

/** The options the store handed to the most recent `subscribeLiveTopic` call. */
const lastOptions = (): SubscribeLiveTopicOptions => {
    const call = subscribeMock.mock.calls.at(-1);

    if (call === undefined) {
        throw new Error("subscribeLiveTopic was not called");
    }

    return call[0];
};

const refusal: LiveStreamSubscribeError = { status: 403, subscriptionId: "sub-1", topic: "post:1" };

describe("liveTopic store", () => {
    beforeEach(() => {
        subscribeMock.mockReset();
        subscribeMock.mockImplementation(() => vi.fn<() => void>());
    });

    it("opens nothing until the first subscriber, then subscribes with the options", () => {
        const store = liveTopic({ headers: { "x-tenant": "a" }, topic: "post:1", url: "/live/posts/connect", withCredentials: true });

        expect(subscribeMock).not.toHaveBeenCalled();

        const stop = store.subscribe(() => {});

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledWith(
            expect.objectContaining({ headers: { "x-tenant": "a" }, topic: "post:1", url: "/live/posts/connect", withCredentials: true }),
        );

        stop();
    });

    it("unsubscribes when the last subscriber leaves", () => {
        const unsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementation(() => unsubscribe);

        const stop = liveTopic({ topic: "post:1", url: "/live/posts/connect" }).subscribe(() => {});

        expect(unsubscribe).not.toHaveBeenCalled();

        stop();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("does not open a subscription on the server render path", () => {
        Reflect.deleteProperty(globalThis, "window");

        try {
            const stop = liveTopic({ topic: "post:1", url: "/live/posts/connect" }).subscribe(() => {});

            expect(subscribeMock).not.toHaveBeenCalled();

            stop();
        } finally {
            Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
        }
    });

    it("resubscribes when the topic changes, closing the previous subscription first", () => {
        const options = writable<SubscribeLiveTopicOptions>({ topic: "post:1", url: "/live/posts/connect" });
        const firstUnsubscribe = vi.fn<() => void>();
        const secondUnsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementationOnce(() => firstUnsubscribe).mockImplementationOnce(() => secondUnsubscribe);

        const stop = liveTopic(options).subscribe(() => {});

        expect(subscribeMock).toHaveBeenCalledTimes(1);

        options.set({ topic: "post:2", url: "/live/posts/connect" });

        expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(2);
        expect(lastOptions().topic).toBe("post:2");

        stop();

        expect(secondUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it("resubscribes when the session key changes, closing the previous subscription first", () => {
        const options = writable<SubscribeLiveTopicOptions>({ sessionKey: "user-1", topic: "post:1", url: "/live/posts/connect" });
        const firstUnsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementationOnce(() => firstUnsubscribe).mockImplementationOnce(() => vi.fn<() => void>());

        const stop = liveTopic(options).subscribe(() => {});

        options.set({ sessionKey: "user-2", topic: "post:1", url: "/live/posts/connect" });

        expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(2);
        expect(lastOptions().sessionKey).toBe("user-2");

        stop();
    });

    it("does not resubscribe when only the callback identities change, and calls the latest", () => {
        const firstHandler = vi.fn<() => void>();
        const latestHandler = vi.fn<() => void>();
        const options = writable<SubscribeLiveTopicOptions>({ onEvent: firstHandler, topic: "post:1", url: "/live/posts/connect" });

        const stop = liveTopic(options).subscribe(() => {});

        options.set({ onEvent: latestHandler, topic: "post:1", url: "/live/posts/connect" });

        expect(subscribeMock).toHaveBeenCalledTimes(1);

        lastOptions().onEvent?.({ body: "hi" });

        expect(latestHandler).toHaveBeenCalledWith({ body: "hi" });
        expect(firstHandler).not.toHaveBeenCalled();

        stop();
    });

    it("updates lastEvent on each delivered payload and starts undefined", () => {
        const store = liveTopic({ topic: "post:1", url: "/live/posts/connect" });
        const stop = store.subscribe(() => {});

        expect(get(store).lastEvent).toBeUndefined();

        lastOptions().onEvent?.({ body: "first" });

        expect(get(store).lastEvent).toStrictEqual({ body: "first" });

        lastOptions().onEvent?.({ body: "second" });

        expect(get(store).lastEvent).toStrictEqual({ body: "second" });

        stop();
    });

    it("sets error when the shard refuses the subscription, and forwards it to onError", () => {
        const onError = vi.fn<() => void>();
        const store = liveTopic({ onError, topic: "post:1", url: "/live/posts/connect" });
        const stop = store.subscribe(() => {});

        expect(get(store).error).toBeUndefined();

        lastOptions().onError?.(refusal);

        expect(get(store).error).toStrictEqual(refusal);
        expect(onError).toHaveBeenCalledWith(refusal);

        stop();
    });
});
