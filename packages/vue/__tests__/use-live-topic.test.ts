import type { LiveStreamSubscribeError, LiveTopicRef, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

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

// The composable reads its base URL from the injected client; the client itself is not under test here.
vi.mock(import("../src/lunora-provider"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, useLunora: () => ({ url: "https://api.test" }) as never };
});

const URL = "https://api.test/live/posts/connect";

/** A reference as `_generated/live.ts` hands one out, for the `posts` stream. */
const topicRef = <Payload = unknown>(topic: string): LiveTopicRef<Payload> => {
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

/** Run `useLiveTopic` inside a fresh effect scope, so the test can dispose it like a component unmount. */
const mount = (...args: Parameters<typeof useLiveTopic>) => {
    const scope = effectScope();
    const result: UseLiveTopicResult = scope.run(() => useLiveTopic(...args))!;

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

        mount(topicRef("post:1"), { withCredentials: true });

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(1);
        expect(subscribeLiveTopic).toHaveBeenCalledWith(expect.objectContaining({ topic: "post:1", url: URL, withCredentials: true }));
    });

    it("unsubscribes when the scope is disposed", () => {
        expect.hasAssertions();

        const { scope } = mount(topicRef("post:1"));
        const { unsubscribe } = subscriptionAt(0);

        expect(unsubscribe).not.toHaveBeenCalled();

        scope.stop();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("resolves ref and getter fields, and resubscribes when a reactive topic changes", async () => {
        expect.hasAssertions();

        const topic = ref(topicRef("a"));
        const { result } = mount(topic, {
            headers: () => {
                return { "x-tenant": "t" };
            },
        });

        expect(subscriptionAt(0).options.topic).toBe("a");

        subscriptionAt(0).options.onEvent?.({ from: "a" });

        expect(result.lastEvent.value).toStrictEqual({ from: "a" });

        topic.value = topicRef("b");
        await nextTick();

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(2);
        expect(subscriptionAt(0).unsubscribe).toHaveBeenCalledTimes(1);
        expect(subscriptionAt(1).options.topic).toBe("b");
        expect(result.lastEvent.value).toBeUndefined();
    });

    it("resubscribes when the session key changes", async () => {
        expect.hasAssertions();

        const sessionKey = ref("user-1");

        mount(topicRef("a"), { sessionKey });
        sessionKey.value = "user-2";
        await nextTick();

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(2);
        expect(subscriptionAt(1).options.sessionKey).toBe("user-2");
    });

    it("does not resubscribe when only a callback changes, and calls the latest one", async () => {
        expect.hasAssertions();

        const firstOnEvent = vi.fn<(payload: unknown) => void>();
        const secondOnEvent = vi.fn<(payload: unknown) => void>();
        const options: NonNullable<Parameters<typeof useLiveTopic>[1]> = { onEvent: firstOnEvent };

        mount(topicRef("a"), options);
        options.onEvent = secondOnEvent;
        await nextTick();

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(1);

        subscriptionAt(0).options.onEvent?.({ n: 1 });

        expect(firstOnEvent).not.toHaveBeenCalled();
        expect(secondOnEvent).toHaveBeenCalledWith({ n: 1 });
    });

    it("does not resubscribe when the same headers arrive in a different order", async () => {
        expect.hasAssertions();

        const headers = ref({ a: "1", b: "2" });

        mount(topicRef("a"), { headers });
        headers.value = { b: "2", a: "1" };
        await nextTick();

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(1);
    });

    it("exposes the last delivered payload as lastEvent", () => {
        expect.hasAssertions();

        const { result } = mount(topicRef("a"));

        expect(result.lastEvent.value).toBeUndefined();

        subscriptionAt(0).options.onEvent?.({ id: 1 });

        expect(result.lastEvent.value).toStrictEqual({ id: 1 });

        subscriptionAt(0).options.onEvent?.({ id: 2 });

        expect(result.lastEvent.value).toStrictEqual({ id: 2 });
    });

    it("sets error and calls onError when the shard refuses the subscription", () => {
        expect.hasAssertions();

        const onError = vi.fn<(error: LiveStreamSubscribeError) => void>();
        const { result } = mount(topicRef("a"), { onError });
        const refusal: LiveStreamSubscribeError = { status: 403, subscriptionId: "sub-1", topic: "a" };

        expect(result.error.value).toBeUndefined();

        subscriptionAt(0).options.onError?.(refusal);

        expect(result.error.value).toStrictEqual(refusal);
        expect(onError).toHaveBeenCalledWith(refusal);
    });

    it("clears a refusal once a payload arrives", () => {
        expect.hasAssertions();

        const { result } = mount(topicRef("a"));

        subscriptionAt(0).options.onError?.({ status: 403, subscriptionId: "sub-1", topic: "a" });

        expect(result.error.value).toBeDefined();

        subscriptionAt(0).options.onEvent?.({ id: 1 });

        expect(result.error.value).toBeUndefined();
        expect(result.lastEvent.value).toStrictEqual({ id: 1 });
    });

    it("does nothing during SSR: no subscription, and the refs stay at their initial values", () => {
        expect.hasAssertions();

        Reflect.deleteProperty(globalThis, "window");

        const { result } = mount(topicRef("a"));

        expect(subscribeLiveTopic).not.toHaveBeenCalled();
        expect(result.lastEvent.value).toBeUndefined();
        expect(result.error.value).toBeUndefined();
    });

    it("resolves the stream's route against the client's URL, on a reactive shard", async () => {
        expect.hasAssertions();

        const shardKey = ref("a");

        mount(topicRef("post:1"), { shardKey });
        shardKey.value = "b";
        await nextTick();

        expect(subscriptionAt(0).options.url).toBe(`${URL}?shard=a`);
        expect(subscriptionAt(1).options.url).toBe(`${URL}?shard=b`);
    });

    it("types lastEvent and onEvent by the payload the topic declares", () => {
        expect.hasAssertions();

        const result = effectScope().run(() =>
            useLiveTopic(topicRef<{ text: string }>("a"), { onEvent: (payload) => expectTypeOf(payload).toEqualTypeOf<{ text: string }>() }),
        )!;

        expectTypeOf(result.lastEvent.value).toEqualTypeOf<{ text: string } | undefined>();

        // @ts-expect-error -- the topic carries `{ text: string }`, not a number
        useLiveTopic(topicRef<{ text: string }>("a"), { onEvent: (payload: number) => payload });

        expect(subscribeLiveTopic).toHaveBeenCalledTimes(2);
    });
});
