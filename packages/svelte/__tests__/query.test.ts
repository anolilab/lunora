import type { FunctionReference, LunoraClient, SubscriptionErrorCallback } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import { query } from "../src/query";

const fnRef = { __lunoraRef: "messages:list" } as unknown as FunctionReference;
const args = { room: "general" } as unknown;

const createFakeClient = () => {
    const unsubscribe = vi.fn<() => void>();
    let lastCallback: ((value: unknown) => void) | undefined;
    let lastOnError: ((error: { message: string }) => void) | undefined;

    const subscribe = vi.fn<
        (function_: unknown, args: unknown, callback: (value: unknown) => void, options?: { onError?: (error: { message: string }) => void }) => () => void
    >((_function, _args, callback, options) => {
        lastCallback = callback;
        lastOnError = options?.onError;

        return unsubscribe;
    });

    const client = { subscribe } as unknown as LunoraClient;

    return {
        client,
        emit: (value: unknown) => lastCallback?.(value),
        emitError: (message: string) => lastOnError?.({ message }),
        subscribe,
        unsubscribe,
    };
};

describe("query store", () => {
    it("is undefined before any value and opens no subscription until read", () => {
        const { client, subscribe } = createFakeClient();

        const store = query(client, fnRef, args);

        // Reading via `get` triggers start → subscribe, but no value emitted yet.
        expect(subscribe).not.toHaveBeenCalled();
        expect(get(store)).toBeUndefined();
    });

    it("subscribes against the client on first subscriber and unsubscribes on stop", () => {
        const { client, subscribe, unsubscribe } = createFakeClient();
        const store = query(client, fnRef, args, { shardKey: "general" });

        const stop = store.subscribe(() => {});

        expect(subscribe).toHaveBeenCalledTimes(1);

        const [passedFunction, passedArgs, , options] = subscribe.mock.calls[0]!;

        expect(passedFunction).toBe(fnRef);
        expect(passedArgs).toBe(args);
        expect(options).toMatchObject({ shardKey: "general" });

        stop();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("re-emits server deltas to readers", () => {
        const { client, emit } = createFakeClient();
        const store = query(client, fnRef, args);

        const seen: unknown[] = [];
        const stop = store.subscribe((value) => seen.push(value));

        emit([{ id: 1 }]);
        emit([{ id: 1 }, { id: 2 }]);

        expect(seen).toStrictEqual([undefined, [{ id: 1 }], [{ id: 1 }, { id: 2 }]]);

        stop();
    });

    it("opens no subscription and stays undefined when args is 'skip'", () => {
        const { client, subscribe } = createFakeClient();

        const store = query(client, fnRef, "skip");

        const stop = store.subscribe(() => {});

        // The shared query state machine short-circuits the skip sentinel: no
        // socket opens and the value stays undefined (fires the onReset sink).
        expect(subscribe).not.toHaveBeenCalled();
        expect(get(store)).toBeUndefined();

        stop();
    });

    it("forwards subscription errors to the onError option", () => {
        const { client, emitError } = createFakeClient();
        const onError = vi.fn<SubscriptionErrorCallback>();
        const store = query(client, fnRef, args, { onError });

        const stop = store.subscribe(() => {});

        emitError("subscription failed");

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: "subscription failed" });

        stop();
    });
});
