import type { LiveStreamSubscribeError, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe(useLiveTopic, () => {
    beforeEach(() => {
        subscriptions.length = 0;
        vi.mocked(subscribeLiveTopic).mockClear();
    });

    it("subscribes on mount with the connection options", () => {
        expect.hasAssertions();

        renderHook(() => useLiveTopic({ topic: "post:1", url: URL, withCredentials: true }));

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(1);
        expect(subscribeLiveTopic).toHaveBeenCalledWith(expect.objectContaining({ topic: "post:1", url: URL, withCredentials: true }));
    });

    it("unsubscribes on unmount", () => {
        expect.hasAssertions();

        const { unmount } = renderHook(() => useLiveTopic({ topic: "post:1", url: URL }));
        const { unsubscribe } = subscriptionAt(0);

        expect(unsubscribe).not.toHaveBeenCalled();

        unmount();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("resubscribes when the topic changes and drops the previous topic's value", () => {
        expect.hasAssertions();

        const { rerender, result } = renderHook(({ topic }) => useLiveTopic({ topic, url: URL }), { initialProps: { topic: "a" } });

        act(() => {
            subscriptionAt(0).options.onEvent?.({ from: "a" });
        });

        expect(result.current.lastEvent).toStrictEqual({ from: "a" });

        rerender({ topic: "b" });

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(2);
        expect(subscriptionAt(0).unsubscribe).toHaveBeenCalledTimes(1);
        expect(subscriptionAt(1).options.topic).toBe("b");
        expect(result.current.lastEvent).toBeUndefined();
    });

    it("does not resubscribe when only the callback identity changes, and calls the latest one", () => {
        expect.hasAssertions();

        const firstOnEvent = vi.fn<(payload: unknown) => void>();
        const secondOnEvent = vi.fn<(payload: unknown) => void>();
        const { rerender } = renderHook(({ onEvent }) => useLiveTopic({ onEvent, topic: "a", url: URL }), {
            initialProps: { onEvent: firstOnEvent },
        });

        rerender({ onEvent: secondOnEvent });

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(1);

        act(() => {
            subscriptionAt(0).options.onEvent?.({ n: 1 });
        });

        expect(firstOnEvent).not.toHaveBeenCalled();
        expect(secondOnEvent).toHaveBeenCalledWith({ n: 1 });
    });

    it("does not resubscribe when an inline headers literal is recreated with the same content", () => {
        expect.hasAssertions();

        const { rerender } = renderHook(() => useLiveTopic({ headers: { authorization: "Bearer t" }, topic: "a", url: URL }));

        rerender();
        rerender();

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(1);
    });

    it("exposes the last delivered payload as lastEvent", () => {
        expect.hasAssertions();

        const { result } = renderHook(() => useLiveTopic({ topic: "a", url: URL }));

        expect(result.current.lastEvent).toBeUndefined();

        act(() => {
            subscriptionAt(0).options.onEvent?.({ id: 1 });
        });

        expect(result.current.lastEvent).toStrictEqual({ id: 1 });

        act(() => {
            subscriptionAt(0).options.onEvent?.({ id: 2 });
        });

        expect(result.current.lastEvent).toStrictEqual({ id: 2 });
    });

    it("sets error and calls onError when the shard refuses the subscription", () => {
        expect.hasAssertions();

        const onError = vi.fn<(error: LiveStreamSubscribeError) => void>();
        const { result } = renderHook(() => useLiveTopic({ onError, topic: "a", url: URL }));
        const refusal: LiveStreamSubscribeError = { status: 403, subscriptionId: "sub-1", topic: "a" };

        expect(result.current.error).toBeUndefined();

        act(() => {
            subscriptionAt(0).options.onError?.(refusal);
        });

        expect(result.current.error).toStrictEqual(refusal);
        expect(onError).toHaveBeenCalledWith(refusal);
    });

    it("is a no-op under server rendering and returns the initial values", () => {
        expect.hasAssertions();

        const Probe = (): string => {
            const { error, lastEvent } = useLiveTopic({ topic: "a", url: URL });

            return `${String(lastEvent)}|${error === undefined ? "none" : "set"}`;
        };

        expect(renderToString(<Probe />)).toBe("undefined|none");
        expect(subscribeLiveTopic).not.toHaveBeenCalled();
    });
});
