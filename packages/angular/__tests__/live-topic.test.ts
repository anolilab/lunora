import type { LiveStreamSubscribeError, LiveTopicRef, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { liveTopic } from "../src/live-topic";
import { createFakeDestroyRef } from "./fake-client";

vi.mock(import("@lunora/client"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, subscribeLiveTopic: vi.fn<typeof subscribeLiveTopic>() };
});

const subscribeMock = vi.mocked(subscribeLiveTopic);

const URL = "https://api.test/live/posts/connect";

/** The client the stream's route is resolved against; only its URL is read. */
const client = { url: "https://api.test" } as never;

/** A reference as `_generated/live.ts` hands one out, for the `posts` stream. */
const ref = <Payload = unknown>(topic: string): LiveTopicRef<Payload> => {
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

describe(liveTopic, () => {
    beforeEach(() => {
        subscribeMock.mockReset();
        subscribeMock.mockImplementation(() => vi.fn<() => void>());
    });

    it("subscribes with the topic and connection options, and leaves lastEvent undefined", () => {
        const destroy = createFakeDestroyRef();

        const { lastEvent } = liveTopic(ref("post:1"), {
            client,
            destroyRef: destroy.asDestroyRef,
            headers: { "x-tenant": "a" },
            withCredentials: true,
        });

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledWith(expect.objectContaining({ headers: { "x-tenant": "a" }, topic: "post:1", url: URL, withCredentials: true }));
        expect(lastEvent()).toBeUndefined();
    });

    it("unsubscribes when the owning DestroyRef fires", () => {
        const destroy = createFakeDestroyRef();
        const unsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementation(() => unsubscribe);

        liveTopic(ref("post:1"), { client, destroyRef: destroy.asDestroyRef });

        expect(unsubscribe).not.toHaveBeenCalled();

        destroy.destroy();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("updates lastEvent on each delivered payload", () => {
        const destroy = createFakeDestroyRef();
        const { lastEvent } = liveTopic(ref("post:1"), { client, destroyRef: destroy.asDestroyRef });

        lastOptions().onEvent?.({ body: "first" });

        expect(lastEvent()).toStrictEqual({ body: "first" });

        lastOptions().onEvent?.({ body: "second" });

        expect(lastEvent()).toStrictEqual({ body: "second" });
    });

    it("sets error when the shard refuses the subscription, and forwards it to onError", () => {
        const destroy = createFakeDestroyRef();
        const onError = vi.fn<() => void>();
        const { error } = liveTopic(ref("post:1"), { client, destroyRef: destroy.asDestroyRef, onError });

        expect(error()).toBeUndefined();

        lastOptions().onError?.(refusal);

        expect(error()).toStrictEqual(refusal);
        expect(onError).toHaveBeenCalledWith(refusal);
    });

    it("reads onEvent at call time, so a static options object's callback is the one invoked", () => {
        const destroy = createFakeDestroyRef();
        const onEvent = vi.fn<() => void>();

        liveTopic(ref("post:1"), { client, destroyRef: destroy.asDestroyRef, onEvent });

        lastOptions().onEvent?.({ body: "hi" });

        expect(onEvent).toHaveBeenCalledWith({ body: "hi" });
    });

    it("resolves the stream's route against the client's URL, on the shard asked for", () => {
        const destroy = createFakeDestroyRef();

        liveTopic(ref("post:1"), { client, destroyRef: destroy.asDestroyRef, shardKey: "tenant-1" });

        expect(lastOptions()).toMatchObject({ topic: "post:1", url: `${URL}?shard=tenant-1` });
    });

    it("types lastEvent and onEvent by the payload the topic declares", () => {
        const destroy = createFakeDestroyRef();
        const { lastEvent } = liveTopic(ref<{ text: string }>("a"), {
            client,
            destroyRef: destroy.asDestroyRef,
            onEvent: (payload) => expectTypeOf(payload).toEqualTypeOf<{ text: string }>(),
        });

        expectTypeOf(lastEvent()).toEqualTypeOf<{ text: string } | undefined>();

        // @ts-expect-error -- the topic carries `{ text: string }`, not a number
        liveTopic(ref<{ text: string }>("a"), { client, destroyRef: destroy.asDestroyRef, onEvent: (payload: number) => payload });

        expect(subscribeMock).toHaveBeenCalledTimes(2);
    });
});
