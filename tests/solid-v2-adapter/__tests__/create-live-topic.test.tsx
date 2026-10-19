import { subscribeLiveTopic } from "@lunora/client";
import { createLiveTopic } from "@lunora/solid";
import { render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("@lunora/client"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, subscribeLiveTopic: vi.fn<typeof subscribeLiveTopic>() };
});

const subscribeMock = vi.mocked(subscribeLiveTopic);

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
        render(() => {
            createLiveTopic({ topic: "post:1", url: "/live/posts/connect" });

            return <div />;
        });
        flush();

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledWith(expect.objectContaining({ topic: "post:1", url: "/live/posts/connect" }));
    });

    it("unsubscribes on unmount", () => {
        const unsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementation(() => unsubscribe);

        const { unmount } = render(() => {
            createLiveTopic({ topic: "post:1", url: "/live/posts/connect" });

            return <div />;
        });
        flush();

        unmount();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("resubscribes when the topic changes", () => {
        const [topic, setTopic] = createSignal("post:1");
        const firstUnsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementationOnce(() => firstUnsubscribe).mockImplementation(() => vi.fn<() => void>());

        render(() => {
            createLiveTopic(() => ({ topic: topic(), url: "/live/posts/connect" }));

            return <div />;
        });
        flush();

        setTopic("post:2");
        flush();

        expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(2);
        expect(subscribeMock).toHaveBeenLastCalledWith(expect.objectContaining({ topic: "post:2" }));
    });
});
