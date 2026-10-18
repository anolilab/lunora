import { Injector, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveTopic } from "../src/live-topic";
import { createFakeDestroyRef } from "./fake-client";

vi.mock(import("@lunora/client"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, subscribeLiveTopic: vi.fn<typeof subscribeLiveTopic>() };
});

const subscribeMock = vi.mocked(subscribeLiveTopic);

/** The options the adapter handed to the most recent `subscribeLiveTopic` call. */
const lastOptions = (): SubscribeLiveTopicOptions => {
    const call = subscribeMock.mock.calls.at(-1);

    if (call === undefined) {
        throw new Error("subscribeLiveTopic was not called");
    }

    return call[0];
};

// Reactive form: `effect()` needs a bootstrapped environment, so this runs under
// TestBed in the jsdom project (see `live-query.dom.test.ts`).
describe("liveTopic — reactive options", () => {
    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
        subscribeMock.mockReset();
        subscribeMock.mockImplementation(() => vi.fn<() => void>());
    });

    afterEach(() => {
        TestBed.resetTestingModule();
    });

    it("resubscribes when the topic changes, closing the previous subscription first", () => {
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const topic = signal("post:1");
        const firstUnsubscribe = vi.fn<() => void>();
        const secondUnsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementationOnce(() => firstUnsubscribe).mockImplementationOnce(() => secondUnsubscribe);

        liveTopic(
            () => {
                return { topic: topic(), url: "/live/posts/connect" };
            },
            { destroyRef: destroy.asDestroyRef, injector },
        );

        TestBed.tick();

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(lastOptions().topic).toBe("post:1");

        topic.set("post:2");
        TestBed.tick();

        expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(2);
        expect(lastOptions().topic).toBe("post:2");
        expect(secondUnsubscribe).not.toHaveBeenCalled();
    });

    it("does not resubscribe when only the callback identities change, and calls the latest", () => {
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const handler = signal<(payload: unknown) => void>(() => undefined);
        const firstHandler = vi.fn<() => void>();
        const latestHandler = vi.fn<() => void>();

        handler.set(firstHandler);

        liveTopic(
            () => {
                return { onEvent: handler(), topic: "post:1", url: "/live/posts/connect" };
            },
            { destroyRef: destroy.asDestroyRef, injector },
        );

        TestBed.tick();

        handler.set(latestHandler);
        TestBed.tick();

        expect(subscribeMock).toHaveBeenCalledTimes(1);

        lastOptions().onEvent?.({ body: "hi" });

        expect(latestHandler).toHaveBeenCalledWith({ body: "hi" });
        expect(firstHandler).not.toHaveBeenCalled();
    });

    it("tears the reactive subscription down when the DestroyRef fires", () => {
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const unsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementation(() => unsubscribe);

        liveTopic(
            () => {
                return { topic: "post:1", url: "/live/posts/connect" };
            },
            { destroyRef: destroy.asDestroyRef, injector },
        );

        TestBed.tick();

        expect(unsubscribe).not.toHaveBeenCalled();

        destroy.destroy();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
});
