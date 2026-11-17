import type { LiveTopicRef } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { createLiveTopic, LunoraProvider } from "@lunora/solid";
import { render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("@lunora/client"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, subscribeLiveTopic: vi.fn<typeof subscribeLiveTopic>() };
});

const subscribeMock = vi.mocked(subscribeLiveTopic);

// The primitive reads its base URL from the provided client; only its URL is used here.
const client = { url: "https://api.test" } as never;
const URL = "https://api.test/live/posts/connect";

/** A reference as `_generated/live.ts` hands one out, for the `posts` stream. */
const ref = (topic: string): LiveTopicRef => ({ __lunoraLive: "posts", topic });

/** Render `body` inside a provider carrying the stub client. */
const renderWithClient = (body: () => void) =>
    render(
        () => {
            body();

            return <div />;
        },
        { wrapper: (props) => <LunoraProvider client={client}>{props.children}</LunoraProvider> },
    );

/**
 * `createLiveTopic` under Solid 2.0. The effect that owns the subscription goes
 * through the adapter's `trackedEffect` compat path, which takes a different
 * branch on 2.x, so the lifecycle is asserted here too. Effects settle on a
 * microtask in 2.0, hence the `flush()` calls.
 */
describe("createLiveTopic on Solid 2", () => {
    beforeEach(() => {
        subscribeMock.mockReset();
        subscribeMock.mockImplementation(() => vi.fn<() => void>());
    });

    it("subscribes on mount with the topic options", () => {
        renderWithClient(() => {
            createLiveTopic(ref("post:1"));
        });
        flush();

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledWith(expect.objectContaining({ topic: "post:1", url: URL }));
    });

    it("unsubscribes on unmount", () => {
        const unsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementation(() => unsubscribe);

        const { unmount } = renderWithClient(() => {
            createLiveTopic(ref("post:1"));
        });
        flush();

        unmount();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("resubscribes when the topic changes", () => {
        const [topic, setTopic] = createSignal("post:1");
        const firstUnsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementationOnce(() => firstUnsubscribe).mockImplementation(() => vi.fn<() => void>());

        renderWithClient(() => {
            createLiveTopic(() => ref(topic()));
        });
        flush();

        setTopic("post:2");
        flush();

        expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(2);
        expect(subscribeMock).toHaveBeenLastCalledWith(expect.objectContaining({ topic: "post:2" }));
    });
});
