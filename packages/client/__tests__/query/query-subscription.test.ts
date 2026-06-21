import { describe, expect, it, vi } from "vitest";

import type { LunoraClient } from "../../src/lunora-client";
import { createQuerySubscription, SKIP, toSubscriptionError } from "../../src/query/query-subscription";
import type { SubscriptionError, SubscriptionErrorCallback } from "../../src/subscription";
import type { FunctionReference, Unsubscribe } from "../../src/types";

interface SubEntry {
    callback: (value: unknown) => void;
    onError?: SubscriptionErrorCallback;
    ref: string;
}

interface MockClient {
    /** Number of currently-attached subscriptions. */
    readonly activeCount: () => number;
    asClient: LunoraClient;
    /** Push a subscription-scoped error to active subscribers of `ref`. */
    emitError: (ref: string, error: SubscriptionError) => void;
    /** Push a value to active subscribers of `ref`. */
    emitValue: (ref: string, value: unknown) => void;
    subscribe: ReturnType<typeof vi.fn>;
}

const makeRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const createMockClient = (subscribeImpl?: () => Unsubscribe): MockClient => {
    const subs = new Set<SubEntry>();

    const subscribe = vi.fn<
        (reference: FunctionReference, _args: unknown, callback: (value: unknown) => void, options?: { onError?: SubscriptionErrorCallback }) => Unsubscribe
    >((reference, _args, callback, options) => {
        if (subscribeImpl) {
            return subscribeImpl();
        }

        const entry: SubEntry = { callback, onError: options?.onError, ref: reference.__lunoraRef };

        subs.add(entry);

        return () => {
            subs.delete(entry);
        };
    });

    return {
        activeCount: () => subs.size,
        asClient: { subscribe } as unknown as LunoraClient,
        emitError: (ref, error) => {
            for (const entry of subs) {
                if (entry.ref === ref) {
                    entry.onError?.(error);
                }
            }
        },
        emitValue: (ref, value) => {
            for (const entry of subs) {
                if (entry.ref === ref) {
                    entry.callback(value);
                }
            }
        },
        subscribe,
    };
};

describe("createQuerySubscription", () => {
    it("opens a single subscription for live args and routes pushed values to onData", () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const onData = vi.fn<(value: unknown) => void>();

        const unsubscribe = createQuerySubscription(mock.asClient, makeRef("messages:list"), {}, { onData });

        expect(mock.subscribe).toHaveBeenCalledTimes(1);

        mock.emitValue("messages:list", { count: 1 });
        mock.emitValue("messages:list", { count: 2 });

        expect(onData).toHaveBeenNthCalledWith(1, { count: 1 });
        expect(onData).toHaveBeenNthCalledWith(2, { count: 2 });

        unsubscribe();
    });

    it('"skip" short-circuits: no subscribe, onReset fires, teardown is a no-op', () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const onData = vi.fn<(value: unknown) => void>();
        const onReset = vi.fn<() => void>();

        const unsubscribe = createQuerySubscription(mock.asClient, makeRef("messages:list"), SKIP, { onData, onReset });

        expect(mock.subscribe).not.toHaveBeenCalled();
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(onData).not.toHaveBeenCalled();

        // No throw, idempotent.
        expect(() => {
            unsubscribe();
        }).not.toThrow();
    });

    it("teardown releases the underlying subscription", () => {
        expect.hasAssertions();

        const realUnsubscribe = vi.fn<() => void>();
        const mock = createMockClient(() => realUnsubscribe);
        const onData = vi.fn<(value: unknown) => void>();

        const unsubscribe = createQuerySubscription(mock.asClient, makeRef("messages:list"), {}, { onData });

        expect(realUnsubscribe).not.toHaveBeenCalled();

        unsubscribe();

        expect(realUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it("cancellation-guards onData: pushes after teardown do not reach the sink", () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const onData = vi.fn<(value: unknown) => void>();

        const unsubscribe = createQuerySubscription(mock.asClient, makeRef("messages:list"), {}, { onData });

        mock.emitValue("messages:list", { count: 1 });

        expect(onData).toHaveBeenCalledTimes(1);

        // A delivery that races teardown — the underlying mock removes the entry on
        // unsubscribe, but we assert the guard directly by emitting against a captured
        // entry is unnecessary: instead emit, then tear down, then re-emit.
        unsubscribe();
        mock.emitValue("messages:list", { count: 2 });

        expect(onData).toHaveBeenCalledTimes(1);
    });

    it("routes server-pushed subscription errors to onError", () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const onData = vi.fn<(value: unknown) => void>();
        const onError = vi.fn<(error: SubscriptionError) => void>();

        const unsubscribe = createQuerySubscription(mock.asClient, makeRef("admin:list"), {}, { onData, onError });

        mock.emitError("admin:list", { code: "forbidden", message: "nope" });

        expect(onError).toHaveBeenCalledWith({ code: "forbidden", message: "nope" });

        unsubscribe();
    });

    it("does not deliver server errors after teardown", () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const onError = vi.fn<(error: SubscriptionError) => void>();

        const unsubscribe = createQuerySubscription(mock.asClient, makeRef("admin:list"), {}, { onData: vi.fn<(value: unknown) => void>(), onError });

        unsubscribe();
        mock.emitError("admin:list", { message: "late" });

        expect(onError).not.toHaveBeenCalled();
    });

    it("normalises an attach throw to onError when an error sink is present", () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            throw new Error("client is closed");
        });
        const onData = vi.fn<(value: unknown) => void>();
        const onError = vi.fn<(error: SubscriptionError) => void>();

        const unsubscribe = createQuerySubscription(mock.asClient, makeRef("messages:list"), {}, { onData, onError });

        expect(onError).toHaveBeenCalledWith({ message: "client is closed" });
        expect(onData).not.toHaveBeenCalled();

        // Teardown after a failed attach is still safe.
        expect(() => {
            unsubscribe();
        }).not.toThrow();
    });

    it("rethrows an attach throw when no error sink is present", () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            throw new Error("client is closed");
        });

        expect(() => createQuerySubscription(mock.asClient, makeRef("messages:list"), {}, { onData: vi.fn<(value: unknown) => void>() })).toThrow(
            "client is closed",
        );
    });

    it("forwards shardKey to client.subscribe", () => {
        expect.hasAssertions();

        const mock = createMockClient();

        const unsubscribe = createQuerySubscription(
            mock.asClient,
            makeRef("messages:list"),
            {},
            { onData: vi.fn<(value: unknown) => void>() },
            { shardKey: "room-1" },
        );

        expect(mock.subscribe).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: "messages:list" }),
            {},
            expect.any(Function),
            expect.objectContaining({ shardKey: "room-1" }),
        );

        unsubscribe();
    });

    it("only passes an onError callback to the client when a sink wants one", () => {
        expect.hasAssertions();

        const withError = createMockClient();
        const tearWithError = createQuerySubscription(
            withError.asClient,
            makeRef("a"),
            {},
            { onData: vi.fn<(value: unknown) => void>(), onError: vi.fn<(error: SubscriptionError) => void>() },
        );

        expect(withError.subscribe.mock.calls[0]?.[3]?.onError).toBeTypeOf("function");

        tearWithError();

        const withoutError = createMockClient();
        const tearWithoutError = createQuerySubscription(withoutError.asClient, makeRef("a"), {}, { onData: vi.fn<(value: unknown) => void>() });

        expect(withoutError.subscribe.mock.calls[0]?.[3]?.onError).toBeUndefined();

        tearWithoutError();
    });
});

describe("toSubscriptionError", () => {
    it("preserves an Error's message", () => {
        expect.hasAssertions();
        expect(toSubscriptionError(new Error("boom"))).toStrictEqual({ message: "boom" });
    });

    it("stringifies a non-Error throw", () => {
        expect.hasAssertions();
        expect(toSubscriptionError("plain string")).toStrictEqual({ message: "plain string" });
    });
});
