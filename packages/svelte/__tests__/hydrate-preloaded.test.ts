import type { LunoraClient, Preloaded, SubscriptionError } from "@lunora/client";
import { get } from "svelte/store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { hydratePreloaded } from "../src/hydrate-preloaded";

/**
 * A minimal stand-in for the parts of `LunoraClient` the adapter touches.
 * `subscribe` records its callback and returns a spy-able unsubscribe.
 */
const createFakeClient = () => {
    const unsubscribe = vi.fn<() => void>();
    let lastCallback: ((value: unknown) => void) | undefined;
    let lastOnError: ((error: SubscriptionError) => void) | undefined;

    const subscribe = vi.fn<
        (
            function_: unknown,
            args: unknown,
            callback: (value: unknown) => void,
            options?: { onError?: (error: SubscriptionError) => void; shardKey?: string },
        ) => () => void
    >((_function, _args, callback, options) => {
        lastCallback = callback;
        lastOnError = options?.onError;

        return unsubscribe;
    });

    const client = { subscribe } as unknown as LunoraClient;

    return {
        client,
        emit: (value: unknown) => lastCallback?.(value),
        emitError: (error: SubscriptionError) => lastOnError?.(error),
        subscribe,
        unsubscribe,
    };
};

const makePreloaded = <T>(value: T): Preloaded<T> => {
    const token: Preloaded<T> = {
        __lunoraPreloaded: true,
        args: { room: "general" },
        functionPath: "messages:list",
        shardKey: "general",
        value,
    };

    return token;
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

describe(hydratePreloaded, () => {
    it("yields the preloaded value synchronously on first read (no async, no flash)", () => {
        const { client } = createFakeClient();
        const preloaded = makePreloaded([{ id: 1, text: "hello" }]);

        const store = hydratePreloaded(preloaded, client);

        // `get` reads the store synchronously — the seeded value must be there
        // immediately, before any microtask or subscription callback runs.
        expect(get(store)).toStrictEqual([{ id: 1, text: "hello" }]);
    });

    it("does not open a subscription until the store is read/subscribed", () => {
        const { client, subscribe } = createFakeClient();

        hydratePreloaded(makePreloaded("seed"), client);

        // No `$`-read / `.subscribe()` yet → readable's start callback never ran.
        expect(subscribe).not.toHaveBeenCalled();
    });

    it("attaches the live subscription on subscribe and re-emits deltas", () => {
        const { client, emit, subscribe, unsubscribe } = createFakeClient();
        const store = hydratePreloaded(makePreloaded("seed"), client);

        const seen: unknown[] = [];
        const stop = store.subscribe((value) => seen.push(value));

        // First value is the synchronous seed; subscribing opened the WS sub.
        expect(seen[0]).toBe("seed");
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(subscribe.mock.calls[0]?.[0]).toStrictEqual({ __lunoraRef: "messages:list" });

        // A server delta flows through.
        emit("live update");

        expect(seen.at(-1)).toBe("live update");

        // Tearing down the last subscriber closes the underlying subscription.
        stop();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("forwards onError so a server-pushed subscription error reaches the caller", () => {
        // Regression: the live subscription behind the SSR seed had no error
        // channel, so a session expiry after hydration was fanned to nobody and
        // the snapshot kept rendering as if it were live.
        const { client, emitError } = createFakeClient();
        const errors: SubscriptionError[] = [];
        const store = hydratePreloaded(makePreloaded("seed"), client, { onError: (error) => errors.push(error) });

        const stop = store.subscribe(() => {});

        emitError({ code: "UNAUTHORIZED", message: "session expired" });

        expect(errors).toStrictEqual([{ code: "UNAUTHORIZED", message: "session expired" }]);

        stop();
    });
});

// Regression: `readable`'s start callback is NOT browser-only. Svelte's server
// runtime resolves `{$store}` by calling `subscribe_to_store`, so every store
// read in a server-rendered template runs its start callback — opening a live
// socket per rendered request against a client whose URL does not resolve
// server-side, and throwing straight out of the render when that URL is the
// relative/empty one the SvelteKit template builds.
describe("hydratePreloaded during SSR", () => {
    it("opens no subscription without a browser window and holds the seeded value", () => {
        const original = Reflect.getOwnPropertyDescriptor(globalThis, "window");

        Reflect.deleteProperty(globalThis, "window");

        try {
            const { client, subscribe } = createFakeClient();
            const store = hydratePreloaded(makePreloaded("seed"), client);

            const stop = store.subscribe(() => {});

            expect(subscribe).not.toHaveBeenCalled();
            expect(get(store)).toBe("seed");

            stop();
        } finally {
            if (original) {
                Object.defineProperty(globalThis, "window", original);
            }
        }
    });
});
