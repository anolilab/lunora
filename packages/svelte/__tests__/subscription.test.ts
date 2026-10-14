import type { FunctionReference, LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
import { get, writable } from "svelte/store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { subscription } from "../src/subscription";

const fnRef = { __lunoraRef: "messages:subscribe" } as unknown as FunctionReference;
const args = { channelId: "c1" } as unknown;

const createFakeClient = () => {
    const unsubscribeSpy = vi.fn<() => void>();
    let lastCallback: ((value: unknown) => void) | undefined;
    let lastOnError: ((error: { code?: string; message: string }) => void) | undefined;

    const subscribeSpy = vi.fn<
        (
            function_: unknown,
            args: unknown,
            callback: (value: unknown) => void,
            options?: { onError?: (error: { code?: string; message: string }) => void },
        ) => () => void
    >((_fn, _args, callback, options) => {
        lastCallback = callback;
        lastOnError = options?.onError;

        return unsubscribeSpy;
    });

    const client = { subscribe: subscribeSpy } as unknown as LunoraClient;

    return {
        client,
        emit: (value: unknown) => lastCallback?.(value),
        emitError: (message: string, code?: string) => lastOnError?.(code === undefined ? { message } : { code, message }),
        subscribeSpy,
        unsubscribeSpy,
    };
};

// Every subscribing primitive in this package gates on a browser `window` (the
// SSR guard — svelte's server runtime subscribes to `{$store}` during
// `render()`, so a `readable`'s start callback runs on the server too). The
// vitest env is `node`, so define one for the client-path tests. Mirrors the
// same stub in `flag.test.ts` / `presence.test.ts`.
/* eslint-disable vitest/require-top-level-describe -- the `window` stub is shared by every describe in this file, so it belongs at file scope */
beforeAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
});
/* eslint-enable vitest/require-top-level-describe */

describe("subscription store", () => {
    it("data is undefined before any push", () => {
        const { client } = createFakeClient();
        const { data } = subscription(client, fnRef, args);

        // data store is lazy — no subscription until first subscriber
        const stop = data.subscribe(() => {});

        expect(get(data)).toBeUndefined();

        stop();
    });

    it("opens subscription on first data subscriber and closes on stop", () => {
        const { client, subscribeSpy, unsubscribeSpy } = createFakeClient();
        const { data } = subscription(client, fnRef, args, { shardKey: "c1" });

        const stop = data.subscribe(() => {});

        expect(subscribeSpy).toHaveBeenCalledTimes(1);

        stop();

        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("delivers server pushes to data store", () => {
        const { client, emit } = createFakeClient();
        const { data } = subscription(client, fnRef, args);

        const seen: unknown[] = [];
        const stop = data.subscribe((v) => seen.push(v));

        emit([{ id: "1" }]);
        emit([{ id: "1" }, { id: "2" }]);

        expect(seen).toStrictEqual([undefined, [{ id: "1" }], [{ id: "1" }, { id: "2" }]]);

        stop();
    });

    it("opens no subscription when args is 'skip'", () => {
        const { client, subscribeSpy } = createFakeClient();
        const { data } = subscription(client, fnRef, "skip");

        const stop = data.subscribe(() => {});

        expect(subscribeSpy).not.toHaveBeenCalled();

        stop();
    });

    it("routes a subscription error into the error store and the onError callback", () => {
        const { client, emitError } = createFakeClient();
        const onError = vi.fn<(error: Error) => void>();
        const { data, error } = subscription(client, fnRef, args, { onError });

        // Subscribe both stores so the data store's start callback wires onError.
        const stopData = data.subscribe(() => {});
        const stopError = error.subscribe(() => {});

        emitError("boom");

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);

        const captured = get(error);

        expect(captured).toBeInstanceOf(Error);
        expect(captured?.message).toBe("boom");

        stopData();
        stopError();
    });

    it("preserves the server-supplied code on the error store as a LunoraError", () => {
        // Sibling gap: Vue/Solid's subscription primitives keep `code` so a
        // consumer can branch on UNAUTHORIZED vs NOT_FOUND; a bare `Error` lost it.
        const { client, emitError } = createFakeClient();
        const { data, error } = subscription(client, fnRef, args);

        const stop = data.subscribe(() => {});

        emitError("denied", "FORBIDDEN");

        const captured = get(error);

        expect(captured).toBeInstanceOf(LunoraError);
        expect((captured as LunoraError).code).toBe("FORBIDDEN");
        expect(captured?.message).toBe("denied");

        stop();
    });

    it("clears the error store once a healthy value arrives after an error", () => {
        const { client, emit, emitError } = createFakeClient();
        const { data, error } = subscription(client, fnRef, args);

        const stopData = data.subscribe(() => {});
        const stopError = error.subscribe(() => {});

        emitError("transient");

        expect(get(error)).toBeInstanceOf(Error);

        emit([{ id: "1" }]);

        // A fresh server value marks the subscription healthy again.
        expect(get(error)).toBeUndefined();
        expect(get(data)).toStrictEqual([{ id: "1" }]);

        stopData();
        stopError();
    });

    it("resets the error store when the last data subscriber detaches", () => {
        const { client, emitError } = createFakeClient();
        const { data, error } = subscription(client, fnRef, args);

        const stopData = data.subscribe(() => {});
        const stopError = error.subscribe(() => {});

        emitError("boom");

        expect(get(error)).toBeInstanceOf(Error);

        // Tearing down the data subscription clears the captured error.
        stopData();

        expect(get(error)).toBeUndefined();

        stopError();
    });
});

describe("subscription store with reactive args", () => {
    it("re-subscribes with the new args when the args store emits", () => {
        const { client, emit, subscribeSpy, unsubscribeSpy } = createFakeClient();
        const argsStore = writable<unknown>({ channelId: "c1" });
        const { data } = subscription(client, fnRef, argsStore);

        const stop = data.subscribe(() => {});

        expect(subscribeSpy).toHaveBeenCalledTimes(1);
        expect(subscribeSpy.mock.calls[0]?.[1]).toStrictEqual({ channelId: "c1" });

        emit([{ id: "1" }]);

        expect(get(data)).toStrictEqual([{ id: "1" }]);

        argsStore.set({ channelId: "c2" });

        // The previous args' value does not survive the switch.
        expect(get(data)).toBeUndefined();

        // The previous subscription is torn down before the new one opens.
        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(subscribeSpy).toHaveBeenCalledTimes(2);
        expect(subscribeSpy.mock.calls[1]?.[1]).toStrictEqual({ channelId: "c2" });

        stop();

        expect(unsubscribeSpy).toHaveBeenCalledTimes(2);
    });

    it("tears down and clears data on a 'skip' emission", () => {
        const { client, emit, subscribeSpy, unsubscribeSpy } = createFakeClient();
        const argsStore = writable<unknown>({ channelId: "c1" });
        const { data } = subscription(client, fnRef, argsStore);

        const stop = data.subscribe(() => {});

        emit({ unread: 3 });

        expect(get(data)).toStrictEqual({ unread: 3 });

        argsStore.set("skip");

        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(subscribeSpy).toHaveBeenCalledTimes(1);
        expect(get(data)).toBeUndefined();

        stop();
    });
});

// Regression: `readable`'s start callback is NOT browser-only. Svelte's server
// runtime resolves `{$store}` by calling `subscribe_to_store`, so every store
// read in a server-rendered template runs its start callback — opening a live
// socket per rendered request against a client whose URL does not resolve
// server-side, and throwing straight out of the render when that URL is the
// relative/empty one the SvelteKit template builds.
describe("subscription store during SSR", () => {
    it("opens no subscription without a browser window", () => {
        const original = Reflect.getOwnPropertyDescriptor(globalThis, "window");

        Reflect.deleteProperty(globalThis, "window");

        try {
            const { client, subscribeSpy } = createFakeClient();
            const { data, error } = subscription(client, fnRef, args);

            const stop = data.subscribe(() => {});

            expect(subscribeSpy).not.toHaveBeenCalled();
            expect(get(data)).toBeUndefined();
            expect(get(error)).toBeUndefined();

            stop();
        } finally {
            if (original) {
                Object.defineProperty(globalThis, "window", original);
            }
        }
    });
});
