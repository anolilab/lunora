import type { LiveStreamSubscribeError, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { liveTopic } from "../src/live-topic";
import { createFakeDestroyRef } from "./fake-client";

vi.mock(import("@lunora/client"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, subscribeLiveTopic: vi.fn<typeof subscribeLiveTopic>() };
});

const subscribeMock = vi.mocked(subscribeLiveTopic);

/** The options the adapter handed to the most recent `subscribeLiveTopic` call. */
const lastOptions = (): SubscribeLiveTopicOptions => {
    const call = subscribeMock.mock.calls.at(-1);

    if (call === undefined) {
        throw new Error("subscribeLiveTopic was not called");
    }

    return call[0];
};

const refusal: LiveStreamSubscribeError = { status: 403, subscriptionId: "sub-1", topic: "post:1" };

describe(liveTopic, () => {
    beforeEach(() => {
        subscribeMock.mockReset();
        subscribeMock.mockImplementation(() => vi.fn<() => void>());
    });

    it("subscribes with the topic and connection options, and leaves lastEvent undefined", () => {
        const destroy = createFakeDestroyRef();

        const { lastEvent } = liveTopic(
            { headers: { "x-tenant": "a" }, topic: "post:1", url: "/live/posts/connect", withCredentials: true },
            {
                destroyRef: destroy.asDestroyRef,
            },
        );

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledWith(
            expect.objectContaining({ headers: { "x-tenant": "a" }, topic: "post:1", url: "/live/posts/connect", withCredentials: true }),
        );
        expect(lastEvent()).toBeUndefined();
    });

    it("unsubscribes when the owning DestroyRef fires", () => {
        const destroy = createFakeDestroyRef();
        const unsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementation(() => unsubscribe);

        liveTopic({ topic: "post:1", url: "/live/posts/connect" }, { destroyRef: destroy.asDestroyRef });

        expect(unsubscribe).not.toHaveBeenCalled();

        destroy.destroy();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("updates lastEvent on each delivered payload", () => {
        const destroy = createFakeDestroyRef();
        const { lastEvent } = liveTopic({ topic: "post:1", url: "/live/posts/connect" }, { destroyRef: destroy.asDestroyRef });

        lastOptions().onEvent?.({ body: "first" });

        expect(lastEvent()).toStrictEqual({ body: "first" });

        lastOptions().onEvent?.({ body: "second" });

        expect(lastEvent()).toStrictEqual({ body: "second" });
    });

    it("sets error when the shard refuses the subscription, and forwards it to onError", () => {
        const destroy = createFakeDestroyRef();
        const onError = vi.fn<() => void>();
        const { error } = liveTopic({ onError, topic: "post:1", url: "/live/posts/connect" }, { destroyRef: destroy.asDestroyRef });

        expect(error()).toBeUndefined();

        lastOptions().onError?.(refusal);

        expect(error()).toStrictEqual(refusal);
        expect(onError).toHaveBeenCalledWith(refusal);
    });

    it("reads onEvent at call time, so a static options object's callback is the one invoked", () => {
        const destroy = createFakeDestroyRef();
        const onEvent = vi.fn<() => void>();

        liveTopic({ onEvent, topic: "post:1", url: "/live/posts/connect" }, { destroyRef: destroy.asDestroyRef });

        lastOptions().onEvent?.({ body: "hi" });

        expect(onEvent).toHaveBeenCalledWith({ body: "hi" });
    });
});
