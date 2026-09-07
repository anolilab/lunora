import type { ConnectionStatus, LunoraClient, Unsubscribe } from "@lunora/client";
import { get } from "svelte/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectionStatus } from "../src/connection-status";

/**
 * Minimal stand-in exposing just the connection-status surface the store
 * touches. Records listeners so a test can drive transitions and assert the
 * listener is released when the last subscriber goes away.
 */
const makeFake = (initial: ConnectionStatus) => {
    let current = initial;
    const listeners = new Set<(status: ConnectionStatus) => void>();

    const client = {
        connectionStatus: () => current,
        onConnectionStatus: (listener: (status: ConnectionStatus) => void): Unsubscribe => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
    } as unknown as LunoraClient;

    return {
        client,
        emit: (status: ConnectionStatus) => {
            current = status;

            for (const listener of listeners) {
                listener(status);
            }
        },
        listenerCount: () => listeners.size,
    };
};

// The store gates its listener on a browser `window` (the SSR guard every other
// subscribing primitive in this package applies); the vitest env is `node`, so
// define one or every test below would silently exercise the SSR path instead
// of the one it means to. Mirrors the same stub in `flag.test.ts`.
/* eslint-disable vitest/require-top-level-describe -- the `window` stub is shared by every describe in this file, so it belongs at file scope */
beforeAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
});
/* eslint-enable vitest/require-top-level-describe */

describe(connectionStatus, () => {
    it("emits the current status and every transition to subscribers", () => {
        const fake = makeFake("idle");
        const store = connectionStatus(fake.client);
        const seen: ConnectionStatus[] = [];

        const stop = store.subscribe((status) => {
            seen.push(status);
        });

        // The readable start callback attached on first subscribe.
        expect(fake.listenerCount()).toBe(1);

        fake.emit("connecting");
        fake.emit("connected");

        expect(seen).toStrictEqual(["idle", "connecting", "connected"]);

        stop();

        // The last subscriber left → the listener is released.
        expect(fake.listenerCount()).toBe(0);
    });

    it("reads the current status synchronously via get()", () => {
        const fake = makeFake("connected");
        const store = connectionStatus(fake.client);

        expect(get(store)).toBe("connected");
    });
});

describe("connectionStatus during SSR", () => {
    // A `readable`'s start function runs on its first subscriber, and `$status`
    // in a template subscribes during `renderToString` — so without the guard
    // every server render registers a client listener.
    it("registers no listener without a browser window, and still reports the current status", () => {
        expect.assertions(3);

        const original = Reflect.getOwnPropertyDescriptor(globalThis, "window");

        Reflect.deleteProperty(globalThis, "window");

        try {
            const fake = makeFake("connected");
            const store = connectionStatus(fake.client);

            const stop = store.subscribe(() => {});

            expect(fake.listenerCount()).toBe(0);
            expect(get(store)).toBe("connected");

            stop();

            expect(fake.listenerCount()).toBe(0);
        } finally {
            if (original) {
                Object.defineProperty(globalThis, "window", original);
            }
        }
    });
});
