import type { FunctionReference, LunoraClient, SubscriptionErrorCallback } from "@lunora/client";
import type { Readable } from "svelte/store";
import { get, writable } from "svelte/store";
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

describe("query store with reactive args", () => {
    it("re-subscribes with the new args when the args store emits", () => {
        const { client, emit, subscribe, unsubscribe } = createFakeClient();
        const argsStore = writable<unknown>({ room: "general" });
        const store = query(client, fnRef, argsStore);

        const stop = store.subscribe(() => {});

        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(subscribe.mock.calls[0]?.[1]).toStrictEqual({ room: "general" });

        emit([{ id: 1 }]);

        expect(get(store)).toStrictEqual([{ id: 1 }]);

        argsStore.set({ room: "random" });

        // The previous args' value does not survive the switch: the store reads
        // `undefined` until the new subscription's first frame lands.
        expect(get(store)).toBeUndefined();

        // The previous subscription is torn down before the new one opens.
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(subscribe.mock.calls[1]?.[1]).toStrictEqual({ room: "random" });

        stop();

        expect(unsubscribe).toHaveBeenCalledTimes(2);
    });

    it("does not leak a subscription opened re-entrantly while `open` is still running", () => {
        // A hand-rolled Readable. `isReadableStore` duck-types on `subscribe`, so any
        // conforming store is a valid args source — and one without svelte/store's
        // subscriber_queue can deliver an emission while `open` is still on the stack.
        // A svelte `writable` cannot: its queue defers the callback until `open` has
        // returned, which is why this needs a custom store to reproduce.
        const live = new Set<number>();
        let identifier = 0;
        let emit: ((value: unknown) => void) | undefined;

        const argumentsStore = {
            subscribe: (run: (value: unknown) => void) => {
                emit = run;
                run({ room: "general" });

                return () => {
                    emit = undefined;
                };
            },
        } as Readable<unknown>;

        const subscribe = vi.fn<(function_: unknown, args: unknown) => () => void>((_function, _args) => {
            identifier += 1;

            const current = identifier;

            live.add(current);

            // Emitted from inside the first `open`, before it returns its teardown.
            if (current === 1) {
                emit?.({ room: "random" });
            }

            return () => {
                live.delete(current);
            };
        });

        const client = { subscribe } as unknown as LunoraClient;
        const store = query(client, fnRef, argumentsStore);

        const stop = store.subscribe(() => {});

        stop();

        // Both subscriptions were opened, and neither is still live.
        expect(subscribe).toHaveBeenCalledTimes(2);
        expect([...live]).toStrictEqual([]);
    });

    it("tears down without re-opening and resets to undefined on a 'skip' emission", () => {
        const { client, emit, subscribe, unsubscribe } = createFakeClient();
        const argsStore = writable<unknown>({ room: "general" });
        const store = query(client, fnRef, argsStore);

        const stop = store.subscribe(() => {});

        emit([{ id: 1 }]);

        expect(get(store)).toStrictEqual([{ id: 1 }]);

        argsStore.set("skip");

        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(get(store)).toBeUndefined();

        stop();
    });
});
