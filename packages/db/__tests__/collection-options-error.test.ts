import type { SubscriptionError } from "@lunora/client";
import { createCollection } from "@tanstack/db";
import { describe, expect, it, vi } from "vitest";

import type { LunoraCollectionUtils } from "../src/collection-error-state";
import { lunoraCollectionOptions } from "../src/collection-options";

const ref = { __lunoraRef: "messages:list" } as never;

interface ListSubscription {
    onError: (error: SubscriptionError) => void;
    onRows: (rows: Record<string, unknown>[]) => void;
}

/** A client whose `subscribe` hands the test the callbacks the collection registered. */
const makeClient = (): { client: never; subscriptions: ListSubscription[] } => {
    const subscriptions: ListSubscription[] = [];
    const client = {
        confirmedMutationWatermark: () => 0,
        currentIdentity: () => null,
        subscribe: vi.fn<(...arguments_: unknown[]) => () => void>((_function: unknown, _args: unknown, onRows: unknown, options: unknown) => {
            subscriptions.push({
                onError: (options as { onError: (error: SubscriptionError) => void }).onError,
                onRows: onRows as (rows: Record<string, unknown>[]) => void,
            });

            return () => undefined;
        }),
    };

    return { client: client as never, subscriptions };
};

const writerOf = (): { markReady: ReturnType<typeof vi.fn>; writer: never } => {
    const markReady = vi.fn<() => void>();

    return { markReady, writer: { begin: () => {}, commit: () => {}, markReady, write: () => {} } as never };
};

const ERROR: SubscriptionError = { code: "FORBIDDEN", message: "denied" };

describe("lunoraCollectionOptions: subscription error state", () => {
    it("exposes the error instead of presenting the collection as a successful empty load", () => {
        expect.assertions(5);

        const { client, subscriptions } = makeClient();
        const seen: SubscriptionError[] = [];
        const options = lunoraCollectionOptions({ client, list: ref, onError: (error) => seen.push(error) });
        const { markReady, writer } = writerOf();

        expect(options.utils.isError()).toBe(false);

        (options.config.sync as { sync: (writer: never) => unknown }).sync(writer);
        subscriptions[0]?.onError(ERROR);

        expect(options.utils.isError()).toBe(true);
        expect(options.utils.error()).toStrictEqual(ERROR);
        // It still leaves `loading`, so a rejected subscription never hangs the collection...
        expect(markReady).toHaveBeenCalledTimes(1);
        // ...and the caller's own handler still fires.
        expect(seen).toStrictEqual([ERROR]);
    });

    it("notifies listeners and clears the error when rows arrive again", () => {
        expect.assertions(4);

        const { client, subscriptions } = makeClient();
        const options = lunoraCollectionOptions({ client, list: ref });
        const states: boolean[] = [];

        options.utils.subscribeError(() => {
            states.push(options.utils.isError());
        });
        (options.config.sync as { sync: (writer: never) => unknown }).sync(writerOf().writer);
        subscriptions[0]?.onError(ERROR);

        expect(options.utils.isError()).toBe(true);

        subscriptions[0]?.onRows([{ _id: "a" }]);

        expect(options.utils.isError()).toBe(false);
        expect(options.utils.error()).toBeUndefined();
        expect(states).toStrictEqual([true, false]);
    });

    it("stops notifying an unsubscribed listener and forgets the error when sync is torn down", () => {
        expect.assertions(3);

        const { client, subscriptions } = makeClient();
        const options = lunoraCollectionOptions({ client, list: ref });
        const listener = vi.fn<() => void>();
        const unsubscribe = options.utils.subscribeError(listener);
        const cleanup = (options.config.sync as { sync: (writer: never) => () => void }).sync(writerOf().writer);

        unsubscribe();
        subscriptions[0]?.onError(ERROR);

        expect(listener).not.toHaveBeenCalled();
        expect(options.utils.isError()).toBe(true);

        cleanup();

        // A restarted sync begins from a clean slate rather than inheriting the previous session's failure.
        expect(options.utils.isError()).toBe(false);
    });

    it("forgets a failed scope's error as soon as the collection is re-scoped or detached", () => {
        expect.assertions(6);

        const { client, subscriptions } = makeClient();
        const options = lunoraCollectionOptions({ client, list: ref, scopeBy: "channelId" });
        const states: boolean[] = [];

        options.utils.subscribeError(() => {
            states.push(options.utils.isError());
        });
        (options.config.sync as { sync: (writer: never) => unknown }).sync(writerOf().writer);
        options.scope({ channelId: "a" });
        subscriptions[0]?.onError(ERROR);

        expect(options.utils.isError()).toBe(true);

        // Scope B has delivered nothing yet: scope A's failure is not B's.
        options.scope({ channelId: "b" });

        expect(options.utils.isError()).toBe(false);
        expect(subscriptions).toHaveLength(2);

        subscriptions[1]?.onError(ERROR);

        expect(options.utils.isError()).toBe(true);

        options.scope();

        expect(options.utils.isError()).toBe(false);
        expect(states).toStrictEqual([true, false, true, false]);
    });

    it("is reachable as `collection.utils` on a created TanStack collection", async () => {
        expect.assertions(3);

        const { client, subscriptions } = makeClient();
        const collection = createCollection(lunoraCollectionOptions({ client, list: ref }).config);

        collection.subscribeChanges(() => {});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        subscriptions[0]?.onError(ERROR);

        expect((collection.utils as LunoraCollectionUtils).isError()).toBe(true);
        // It left `loading` rather than hanging, which is exactly why `utils` is needed to tell it apart from an empty load.
        expect(collection.status).not.toBe("loading");
        expect(collection.size).toBe(0);
    });
});
