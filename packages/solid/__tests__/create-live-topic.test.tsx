import type { LiveStreamSubscribeError, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateLiveTopicResult } from "../src/create-live-topic";
import { createLiveTopic } from "../src/create-live-topic";

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

describe(createLiveTopic, () => {
    beforeEach(() => {
        subscribeMock.mockReset();
        subscribeMock.mockImplementation(() => vi.fn<() => void>());
    });

    it("subscribes with the topic and connection options on mount", () => {
        render(() => {
            createLiveTopic({ headers: { "x-tenant": "a" }, topic: "post:1", url: "/live/posts/connect", withCredentials: true });

            return <div />;
        });

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledWith(
            expect.objectContaining({ headers: { "x-tenant": "a" }, topic: "post:1", url: "/live/posts/connect", withCredentials: true }),
        );
    });

    it("unsubscribes when the owner is torn down", () => {
        const unsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementation(() => unsubscribe);

        const { unmount } = render(() => {
            createLiveTopic({ topic: "post:1", url: "/live/posts/connect" });

            return <div />;
        });

        expect(unsubscribe).not.toHaveBeenCalled();

        unmount();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("resubscribes when the topic changes, closing the previous subscription first", () => {
        const [topic, setTopic] = createSignal("post:1");
        const firstUnsubscribe = vi.fn<() => void>();
        const secondUnsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementationOnce(() => firstUnsubscribe).mockImplementationOnce(() => secondUnsubscribe);

        render(() => {
            createLiveTopic(() => {
                return { topic: topic(), url: "/live/posts/connect" };
            });

            return <div />;
        });

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(lastOptions().topic).toBe("post:1");

        setTopic("post:2");

        expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(2);
        expect(lastOptions().topic).toBe("post:2");
        expect(secondUnsubscribe).not.toHaveBeenCalled();
    });

    it("resubscribes when the session key changes, closing the previous subscription first", () => {
        const [sessionKey, setSessionKey] = createSignal("user-1");
        const firstUnsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementationOnce(() => firstUnsubscribe).mockImplementationOnce(() => vi.fn<() => void>());

        render(() => {
            createLiveTopic(() => {
                return { sessionKey: sessionKey(), topic: "post:1", url: "/live/posts/connect" };
            });

            return <div />;
        });

        setSessionKey("user-2");

        expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(2);
        expect(lastOptions().sessionKey).toBe("user-2");
    });

    it("does not resubscribe when only the callback identities change, and calls the latest", () => {
        const [handler, setHandler] = createSignal<(payload: unknown) => void>(() => undefined);
        const firstHandler = vi.fn<() => void>();
        const latestHandler = vi.fn<() => void>();

        setHandler(() => firstHandler);

        render(() => {
            createLiveTopic(() => {
                return { onEvent: handler(), topic: "post:1", url: "/live/posts/connect" };
            });

            return <div />;
        });

        setHandler(() => latestHandler);

        expect(subscribeMock).toHaveBeenCalledTimes(1);

        lastOptions().onEvent?.({ body: "hi" });

        expect(latestHandler).toHaveBeenCalledWith({ body: "hi" });
        expect(firstHandler).not.toHaveBeenCalled();
    });

    it("updates lastEvent on each delivered payload and starts undefined", () => {
        let result: CreateLiveTopicResult | undefined;

        render(() => {
            result = createLiveTopic({ topic: "post:1", url: "/live/posts/connect" });

            return <div />;
        });

        expect(result?.lastEvent()).toBeUndefined();

        lastOptions().onEvent?.({ body: "first" });

        expect(result?.lastEvent()).toStrictEqual({ body: "first" });

        lastOptions().onEvent?.({ body: "second" });

        expect(result?.lastEvent()).toStrictEqual({ body: "second" });
    });

    it("sets error when the shard refuses the subscription, and forwards it to onError", () => {
        const onError = vi.fn<() => void>();
        let result: CreateLiveTopicResult | undefined;

        render(() => {
            result = createLiveTopic({ onError, topic: "post:1", url: "/live/posts/connect" });

            return <div />;
        });

        expect(result?.error()).toBeUndefined();

        lastOptions().onError?.(refusal);

        expect(result?.error()).toStrictEqual(refusal);
        expect(onError).toHaveBeenCalledWith(refusal);
    });
});
