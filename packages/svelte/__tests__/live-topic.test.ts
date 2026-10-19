import type { LiveStreamSubscribeError, LiveTopicOptions, LiveTopicRef, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { get, writable } from "svelte/store";
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { liveTopic } from "../src/live-topic";

vi.mock(import("@lunora/client"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, subscribeLiveTopic: vi.fn<typeof subscribeLiveTopic>() };
});

// The store reads its base URL from the client in context; the client itself is not under test here.
vi.mock(import("../src/context"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, getLunoraClient: () => ({ url: "https://api.test" }) as never };
});

const subscribeMock = vi.mocked(subscribeLiveTopic);

const URL = "https://api.test/live/posts/connect";

/** A reference as `_generated/live.ts` hands one out, for the `posts` stream. */
const ref = <Payload = unknown>(topic: string): LiveTopicRef<Payload> => {
    return { __lunoraLive: "posts", topic };
};

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
        const store = liveTopic(ref("post:1"), { headers: { "x-tenant": "a" }, withCredentials: true });

        expect(subscribeMock).not.toHaveBeenCalled();

        const stop = store.subscribe(() => {});

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledWith(expect.objectContaining({ headers: { "x-tenant": "a" }, topic: "post:1", url: URL, withCredentials: true }));

        stop();
    });

    it("unsubscribes when the last subscriber leaves", () => {
        const unsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementation(() => unsubscribe);

        const stop = liveTopic(ref("post:1")).subscribe(() => {});

        expect(unsubscribe).not.toHaveBeenCalled();

        stop();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("does not open a subscription on the server render path", () => {
        Reflect.deleteProperty(globalThis, "window");

        try {
            const stop = liveTopic(ref("post:1")).subscribe(() => {});

            expect(subscribeMock).not.toHaveBeenCalled();

            stop();
        } finally {
            Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
        }
    });

    it("resubscribes when the topic changes, closing the previous subscription first", () => {
        const topic = writable(ref("post:1"));
        const firstUnsubscribe = vi.fn<() => void>();
        const secondUnsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementationOnce(() => firstUnsubscribe).mockImplementationOnce(() => secondUnsubscribe);

        const stop = liveTopic(topic).subscribe(() => {});

        expect(subscribeMock).toHaveBeenCalledTimes(1);

        topic.set(ref("post:2"));

        expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(2);
        expect(lastOptions().topic).toBe("post:2");

        stop();

        expect(secondUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it("resubscribes when the session key changes, closing the previous subscription first", () => {
        const options = writable<LiveTopicOptions>({ sessionKey: "user-1" });
        const firstUnsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementationOnce(() => firstUnsubscribe).mockImplementationOnce(() => vi.fn<() => void>());

        const stop = liveTopic(ref("post:1"), options).subscribe(() => {});

        options.set({ sessionKey: "user-2" });

        expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(2);
        expect(lastOptions().sessionKey).toBe("user-2");

        stop();
    });

    it("does not resubscribe when only the callback identities change, and calls the latest", () => {
        const firstHandler = vi.fn<() => void>();
        const latestHandler = vi.fn<() => void>();
        const options: LiveTopicOptions = { onEvent: firstHandler };

        const stop = liveTopic(ref("post:1"), options).subscribe(() => {});

        options.onEvent = latestHandler;

        expect(subscribeMock).toHaveBeenCalledTimes(1);

        lastOptions().onEvent?.({ body: "hi" });

        expect(latestHandler).toHaveBeenCalledWith({ body: "hi" });
        expect(firstHandler).not.toHaveBeenCalled();

        stop();
    });

    it("updates lastEvent on each delivered payload and starts undefined", () => {
        const store = liveTopic(ref("post:1"));
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
        const store = liveTopic(ref("post:1"), { onError });
        const stop = store.subscribe(() => {});

        expect(get(store).error).toBeUndefined();

        lastOptions().onError?.(refusal);

        expect(get(store).error).toStrictEqual(refusal);
        expect(onError).toHaveBeenCalledWith(refusal);

        stop();
    });

    it("resolves the stream's route against the client's URL, on the shard asked for", () => {
        const stop = liveTopic(ref("post:1"), { shardKey: "tenant-1" }).subscribe(() => {});

        expect(lastOptions()).toMatchObject({ topic: "post:1", url: `${URL}?shard=tenant-1` });

        stop();
    });

    it("types lastEvent and onEvent by the payload the topic declares", () => {
        const store = liveTopic(ref<{ text: string }>("a"), { onEvent: (payload) => expectTypeOf(payload).toEqualTypeOf<{ text: string }>() });

        expectTypeOf(get(store).lastEvent).toEqualTypeOf<{ text: string } | undefined>();

        // @ts-expect-error -- the topic carries `{ text: string }`, not a number
        liveTopic(ref<{ text: string }>("a"), { onEvent: (payload: number) => payload });

        expect(get(store).lastEvent).toBeUndefined();
    });
});
