import type { LunoraClient, Preloaded } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import { hydratePreloaded } from "../src/hydrate-preloaded";

/**
 * A minimal stand-in for the parts of `LunoraClient` the adapter touches.
 * `subscribe` records its callback and returns a spy-able unsubscribe.
 */
const createFakeClient = () => {
    const unsubscribe = vi.fn<() => void>();
    let lastCallback: ((value: unknown) => void) | undefined;

    const subscribe = vi.fn<(function_: unknown, args: unknown, callback: (value: unknown) => void) => () => void>((_function, _args, callback) => {
        lastCallback = callback;

        return unsubscribe;
    });

    const client = { subscribe } as unknown as LunoraClient;

    return {
        client,
        emit: (value: unknown) => lastCallback?.(value),
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
});
