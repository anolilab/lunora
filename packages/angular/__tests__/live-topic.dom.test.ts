import { Injector, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { LiveTopicRef, SubscribeLiveTopicOptions } from "@lunora/client";
import { subscribeLiveTopic } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveTopicOptions } from "../src/live-topic";
import { liveTopic } from "../src/live-topic";
import { createFakeDestroyRef } from "./fake-client";

vi.mock(import("@lunora/client"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, subscribeLiveTopic: vi.fn<typeof subscribeLiveTopic>() };
});

const subscribeMock = vi.mocked(subscribeLiveTopic);

/** The client the stream's route is resolved against; only its URL is read. */
const client = { url: "https://api.test" } as never;

/** A reference as `_generated/live.ts` hands one out, for the `posts` stream. */
const ref = (topic: string): LiveTopicRef => {
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

        liveTopic(() => ref(topic()), { client, destroyRef: destroy.asDestroyRef, injector });

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

    it("resubscribes when the session key changes, closing the previous subscription first", () => {
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const sessionKey = signal("user-1");
        const firstUnsubscribe = vi.fn<() => void>();

        subscribeMock.mockImplementationOnce(() => firstUnsubscribe).mockImplementationOnce(() => vi.fn<() => void>());

        liveTopic(ref("post:1"), { client, destroyRef: destroy.asDestroyRef, injector, sessionKey });

        TestBed.tick();
        sessionKey.set("user-2");
        TestBed.tick();

        expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledTimes(2);
        expect(lastOptions().sessionKey).toBe("user-2");
    });

    it("does not resubscribe when only the callback identities change, and calls the latest", () => {
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const firstHandler = vi.fn<() => void>();
        const latestHandler = vi.fn<() => void>();
        const options: LiveTopicOptions = { client, destroyRef: destroy.asDestroyRef, injector, onEvent: firstHandler };

        liveTopic(() => ref("post:1"), options);

        TestBed.tick();

        // The callback is read from the options object at call time, so swapping it never reopens the subscription.
        options.onEvent = latestHandler;
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

        liveTopic(() => ref("post:1"), { client, destroyRef: destroy.asDestroyRef, injector });

        TestBed.tick();

        expect(unsubscribe).not.toHaveBeenCalled();

        destroy.destroy();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
});
