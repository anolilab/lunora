import type { LiveStreamSubscribeError, LiveTopicRef, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { CreateLiveTopicResult } from "../src/create-live-topic";
import { createLiveTopic } from "../src/create-live-topic";

vi.mock(import("@lunora/client"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, subscribeLiveTopic: vi.fn<typeof subscribeLiveTopic>() };
});

// The primitive reads its base URL from the context's client; the client itself is not under test here.
vi.mock(import("../src/context"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, useLunora: () => ({ url: "https://api.test" }) as never };
});

const subscribeMock = vi.mocked(subscribeLiveTopic);

const URL = "https://api.test/live/posts/connect";

/** A reference as `_generated/live.ts` hands one out, for the `posts` stream. */
const ref = <Payload = unknown,>(topic: string): LiveTopicRef<Payload> => {
    return { __lunoraLive: "posts", topic };
};

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
            createLiveTopic(ref("post:1"), { headers: { "x-tenant": "a" }, withCredentials: true });

            return <div />;
        });

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledWith(expect.objectContaining({ headers: { "x-tenant": "a" }, topic: "post:1", url: URL, withCredentials: true }));
    });

    it("unsubscribes when the owner is torn down", () => {
        const unsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementation(() => unsubscribe);

        const { unmount } = render(() => {
            createLiveTopic(ref("post:1"));

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
            createLiveTopic(() => ref(topic()));

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
            createLiveTopic(ref("post:1"), () => {
                return { sessionKey: sessionKey() };
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
            createLiveTopic(ref("post:1"), () => {
                return { onEvent: handler() };
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
            result = createLiveTopic(ref("post:1"));

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
            result = createLiveTopic(ref("post:1"), { onError });

            return <div />;
        });

        expect(result?.error()).toBeUndefined();

        lastOptions().onError?.(refusal);

        expect(result?.error()).toStrictEqual(refusal);
        expect(onError).toHaveBeenCalledWith(refusal);
    });

    it("resolves the stream's route against the client's URL, on the shard asked for", () => {
        render(() => {
            createLiveTopic(ref("post:1"), { shardKey: "tenant-1" });

            return <div />;
        });

        expect(lastOptions()).toMatchObject({ topic: "post:1", url: `${URL}?shard=tenant-1` });
    });

    it("types lastEvent and onEvent by the payload the topic declares", () => {
        render(() => {
            const result = createLiveTopic(ref<{ text: string }>("a"), { onEvent: (payload) => expectTypeOf(payload).toEqualTypeOf<{ text: string }>() });

            expectTypeOf(result.lastEvent()).toEqualTypeOf<{ text: string } | undefined>();

            // @ts-expect-error -- the topic carries `{ text: string }`, not a number
            createLiveTopic(ref<{ text: string }>("a"), { onEvent: (payload: number) => payload });

            return <div />;
        });

        expect(subscribeMock).toHaveBeenCalledTimes(2);
    });
});
