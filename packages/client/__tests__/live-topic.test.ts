import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeLiveTopic } from "../src/live-topic";

const stubFetch = () => {
    const connects: string[] = [];
    const aborted: boolean[] = [];

    vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (/\/connect(?:\?|$)/u.test(url)) {
                connects.push(url);
                const index = aborted.push(false) - 1;

                init?.signal?.addEventListener("abort", () => {
                    aborted[index] = true;
                });

                return Promise.resolve(new Response(new ReadableStream<Uint8Array>(), { headers: { "x-lunora-live-connection": `c${String(connects.length)}` } }));
            }

            return Promise.resolve(new Response(undefined, { status: 204 }));
        }),
    );

    return { aborted, connects };
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe(subscribeLiveTopic, () => {
    it("follows several topics over one connection and closes after the last unsubscribe", async () => {
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

    it("does not share a connection between differently configured subscribers", async () => {
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
