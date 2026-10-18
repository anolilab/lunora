import { encodeWire } from "@lunora/wire";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { LiveTopicRef } from "../src/live-topic";
import { encodeLiveTopic, liveTopicSubscription, subscribeLiveTopic } from "../src/live-topic";

/** The request URL as a string, whichever form `fetch` was called with. */
const urlOf = (input: RequestInfo | URL): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

const stubFetch = () => {
    const connects: string[] = [];
    const aborted: boolean[] = [];

    vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const url = urlOf(input);

            if (/\/connect(?:\?|$)/u.test(url)) {
                connects.push(url);
                const index = aborted.push(false) - 1;

                init?.signal?.addEventListener("abort", () => {
                    aborted[index] = true;
                });

                return Promise.resolve(
                    new Response(new ReadableStream<Uint8Array>(), { headers: { "x-lunora-live-connection": `c${String(connects.length)}` } }),
                );
            }

            return Promise.resolve(new Response(undefined, { status: 204 }));
        }),
    );

    return { aborted, connects };
};

describe(subscribeLiveTopic, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("follows several topics over one connection and closes after the last unsubscribe", async () => {
        expect.hasAssertions();

        vi.useFakeTimers();

        const { aborted, connects } = stubFetch();
        const url = "/live/posts/connect";
        const offPost = subscribeLiveTopic({ topic: "post:1", url });
        const offComments = subscribeLiveTopic({ topic: "comments:1", url });

        await vi.advanceTimersByTimeAsync(0);

        expect(connects).toHaveLength(1);

        offPost();
        await vi.advanceTimersByTimeAsync(5);

        expect(aborted[0]).toBe(false);

        offComments();
        offComments();
        await vi.advanceTimersByTimeAsync(5);

        expect(aborted[0]).toBe(true);
    });

    it("keeps the connection when a subscriber leaves and another arrives in the same tick", async () => {
        expect.hasAssertions();

        vi.useFakeTimers();

        const { aborted, connects } = stubFetch();
        const url = "/live/strict/connect";

        subscribeLiveTopic({ topic: "a", url })();
        const off = subscribeLiveTopic({ topic: "a", url });

        await vi.advanceTimersByTimeAsync(5);

        expect(connects).toHaveLength(1);
        expect(aborted[0]).toBe(false);

        off();
        await vi.advanceTimersByTimeAsync(5);
    });

    it("delivers each event once to every subscriber of a topic, over one shard-side subscription", async () => {
        expect.hasAssertions();

        const controls: { action?: string; topic?: string }[] = [];
        let push: ((text: string) => void) | undefined;

        vi.stubGlobal(
            "fetch",
            vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
                if (/\/connect(?:\?|$)/u.test(urlOf(input))) {
                    const stream = new ReadableStream<Uint8Array>({
                        start: (controller) => {
                            push = (text) => {
                                controller.enqueue(new TextEncoder().encode(text));
                            };
                        },
                    });

                    return Promise.resolve(new Response(stream, { headers: { "x-lunora-live-connection": "c1" } }));
                }

                controls.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { action?: string; topic?: string });

                return Promise.resolve(Response.json({ ok: true }));
            }),
        );

        const first: unknown[] = [];
        const second: unknown[] = [];
        const url = "/live/once/connect";
        const offFirst = subscribeLiveTopic({ onEvent: (payload) => first.push(payload), topic: "post:1", url });
        const offSecond = subscribeLiveTopic({ onEvent: (payload) => second.push(payload), topic: "post:1", url });

        await vi.waitFor(() => {
            expect(controls.filter((call) => call.action === "subscribe")).toHaveLength(1);
        });

        push?.(`event: live\ndata: ${JSON.stringify({ data: encodeWire({ n: 1 }), topic: "post:1" })}\n\n`);

        await vi.waitFor(() => {
            expect(first).toStrictEqual([{ n: 1 }]);
        });

        expect(second).toStrictEqual([{ n: 1 }]);

        offFirst();
        offSecond();
    });

    it("registers a 256-character topic under an id the shard accepts", async () => {
        expect.hasAssertions();

        const controls: { subscriptionId?: string; topic?: string }[] = [];

        vi.stubGlobal(
            "fetch",
            vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
                if (/\/connect(?:\?|$)/u.test(urlOf(input))) {
                    return Promise.resolve(new Response(new ReadableStream<Uint8Array>(), { headers: { "x-lunora-live-connection": "c1" } }));
                }

                controls.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { subscriptionId?: string; topic?: string });

                return Promise.resolve(Response.json({ ok: true }));
            }),
        );

        const topic = `t${"x".repeat(255)}`;
        const off = subscribeLiveTopic({ topic, url: "/live/long/connect" });

        await vi.waitFor(() => {
            expect(controls).toHaveLength(1);
        });

        // The shard refuses an id over 256 characters with a 400.
        expect(controls[0]?.topic).toHaveLength(256);
        expect(controls[0]?.subscriptionId?.length).toBeLessThanOrEqual(256);

        off();
    });

    it("does not share a connection between different session keys, and closes the old one when its subscribers leave", async () => {
        expect.hasAssertions();

        vi.useFakeTimers();

        const { aborted, connects } = stubFetch();
        const url = "/live/session/connect";
        const offFirst = subscribeLiveTopic({ sessionKey: "user-1", topic: "a", url });
        const offSecond = subscribeLiveTopic({ sessionKey: "user-2", topic: "a", url });

        await vi.advanceTimersByTimeAsync(0);

        expect(connects).toHaveLength(2);

        offFirst();
        await vi.advanceTimersByTimeAsync(5);

        expect(aborted[0]).toBe(true);
        expect(aborted[1]).toBe(false);

        offSecond();
        await vi.advanceTimersByTimeAsync(5);
    });

    it("does not share a connection between differently configured subscribers", async () => {
        expect.hasAssertions();

        vi.useFakeTimers();

        const { connects } = stubFetch();
        const url = "/live/cfg/connect";
        const offPlain = subscribeLiveTopic({ topic: "a", url });
        const offCreds = subscribeLiveTopic({ topic: "a", url, withCredentials: true });

        await vi.advanceTimersByTimeAsync(0);

        expect(connects).toHaveLength(2);

        offPlain();
        offCreds();
        await vi.advanceTimersByTimeAsync(5);
    });
});

describe(liveTopicSubscription, () => {
    const post = { __lunoraLive: "posts", topic: "post:1" } as LiveTopicRef<{ text: string }>;

    it("builds the stream's connect route under the client's base URL, with the reference's wire topic", () => {
        expect.assertions(3);

        expect(liveTopicSubscription({ url: "https://api.test" }, post)).toStrictEqual({
            onEvent: undefined,
            topic: "post:1",
            url: "https://api.test/live/posts/connect",
        });
        // A trailing slash on the base joins cleanly, and a same-origin client stays relative.
        expect(liveTopicSubscription({ url: "https://api.test/" }, post).url).toBe("https://api.test/live/posts/connect");
        expect(liveTopicSubscription({ url: "" }, post).url).toBe("/live/posts/connect");
    });

    it("puts a shard on the connect URL, where the control calls read it from", () => {
        expect.assertions(1);

        expect(liveTopicSubscription({ url: "https://api.test" }, post, { shardKey: "tenant 1" }).url).toBe(
            "https://api.test/live/posts/connect?shard=tenant+1",
        );
    });

    it("passes the transport tuning through and keeps the shard out of it", () => {
        expect.assertions(2);

        const onEvent = vi.fn<(payload: { text: string }) => void>();
        const subscription = liveTopicSubscription({ url: "https://api.test" }, post, {
            headers: { authorization: "Bearer t" },
            onEvent,
            retryDelay: 5,
            shardKey: "s",
            withCredentials: true,
        });

        expect(subscription).toMatchObject({ headers: { authorization: "Bearer t" }, onEvent, retryDelay: 5, withCredentials: true });
        expect(subscription).not.toHaveProperty("shardKey");
    });

    it("types onEvent by the topic's payload, so a handler for the wrong payload does not compile", () => {
        expect.assertions(1);

        liveTopicSubscription({ url: "" }, post, { onEvent: (payload) => expectTypeOf(payload).toEqualTypeOf<{ text: string }>() });
        // @ts-expect-error -- the topic carries `{ text: string }`, not a number
        liveTopicSubscription({ url: "" }, post, { onEvent: (payload: number) => payload });

        expect(encodeLiveTopic("post", ["id"], { id: "1" })).toBe("post:1");
    });
});
