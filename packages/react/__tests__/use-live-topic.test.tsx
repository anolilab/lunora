import type { LiveStreamSubscribeError, LiveTopicRef, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

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

// The hook reads its base URL from the provider's client; the client itself is not under test here.
vi.mock(import("../src/lunora-provider"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, useLunora: () => ({ url: "https://api.test" }) as never };
});

const URL = "https://api.test/live/posts/connect";

/** A reference as `_generated/live.ts` hands one out, for the `posts` stream. */
const ref = <Payload = unknown,>(topic: string): LiveTopicRef<Payload> => {
    return { __lunoraLive: "posts", topic };
};

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

        renderHook(() => useLiveTopic(ref("post:1"), { withCredentials: true }));

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(1);
        expect(subscribeLiveTopic).toHaveBeenCalledWith(expect.objectContaining({ topic: "post:1", url: URL, withCredentials: true }));
    });

    it("unsubscribes on unmount", () => {
        expect.hasAssertions();

        const { unmount } = renderHook(() => useLiveTopic(ref("post:1")));
        const { unsubscribe } = subscriptionAt(0);

        expect(unsubscribe).not.toHaveBeenCalled();

        unmount();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("resubscribes when the topic changes and drops the previous topic's value", () => {
        expect.hasAssertions();

        const { rerender, result } = renderHook(({ topic }) => useLiveTopic(ref(topic)), { initialProps: { topic: "a" } });

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

    it("resubscribes when the session key changes", () => {
        expect.hasAssertions();

        const { rerender } = renderHook(({ sessionKey }) => useLiveTopic(ref("a"), { sessionKey }), {
            initialProps: { sessionKey: "user-1" },
        });

        rerender({ sessionKey: "user-2" });

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(2);
        expect(subscriptionAt(1).options.sessionKey).toBe("user-2");
    });

    it("does not resubscribe when only the callback identity changes, and calls the latest one", () => {
        expect.hasAssertions();

        const firstOnEvent = vi.fn<(payload: unknown) => void>();
        const secondOnEvent = vi.fn<(payload: unknown) => void>();
        const { rerender } = renderHook(({ onEvent }) => useLiveTopic(ref("a"), { onEvent }), {
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

        const { rerender } = renderHook(() => useLiveTopic(ref("a"), { headers: { authorization: "Bearer t" } }));

        rerender();
        rerender();

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(1);
    });

    it("does not resubscribe when the same headers arrive in a different order", () => {
        expect.hasAssertions();

        const { rerender } = renderHook(({ headers }) => useLiveTopic(ref("a"), { headers }), {
            initialProps: { headers: { a: "1", b: "2" } },
        });

        rerender({ headers: { b: "2", a: "1" } });

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(1);
    });

    it("exposes the last delivered payload as lastEvent", () => {
        expect.hasAssertions();

        const { result } = renderHook(() => useLiveTopic(ref("a")));

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
        const { result } = renderHook(() => useLiveTopic(ref("a"), { onError }));
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
            const { error, lastEvent } = useLiveTopic(ref("a"));

            return `${String(lastEvent)}|${error === undefined ? "none" : "set"}`;
        };

        expect(renderToString(<Probe />)).toBe("undefined|none");
        expect(subscribeLiveTopic).not.toHaveBeenCalled();
    });

    it("resolves the stream's route against the client's URL, on the shard asked for", () => {
        expect.hasAssertions();

        renderHook(() => useLiveTopic(ref("post:1"), { shardKey: "tenant-1" }));

        expect(subscribeLiveTopic).toHaveBeenCalledWith(expect.objectContaining({ topic: "post:1", url: `${URL}?shard=tenant-1` }));
    });

    it("types lastEvent and onEvent by the payload the topic declares", () => {
        expect.hasAssertions();

        const { result } = renderHook(() =>
            useLiveTopic(ref<{ text: string }>("a"), { onEvent: (payload) => expectTypeOf(payload).toEqualTypeOf<{ text: string }>() }),
        );

        expectTypeOf(result.current.lastEvent).toEqualTypeOf<{ text: string } | undefined>();

        renderHook(() =>
            // @ts-expect-error -- the topic carries `{ text: string }`, not a number
            useLiveTopic(ref<{ text: string }>("a"), { onEvent: (payload: number) => payload }),
        );

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(2);
    });
});
