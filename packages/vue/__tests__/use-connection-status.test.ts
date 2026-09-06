import type { ConnectionStatus, LunoraClient, Unsubscribe } from "@lunora/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, effectScope } from "vue";

import { LUNORA_INJECTION_KEY } from "../src/lunora-provider";
import useConnectionStatus from "../src/use-connection-status";

/**
 * Minimal stand-in exposing just the connection-status surface the composable
 * touches. Records listeners so a test can drive transitions and assert the
 * listener is released when the owning effect scope stops.
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

/** Run `fn` with `client` injected and inside an effect scope we can stop. */
const withProvidedScope = <T>(client: LunoraClient, fn: () => T): { result: T; stop: () => void } => {
    const app = createApp({});

    app.provide(LUNORA_INJECTION_KEY, client);

    const scope = effectScope();
    const result = app.runWithContext(() => scope.run(fn) as T);

    return {
        result,
        stop: () => {
            scope.stop();
        },
    };
};

// The composable gates its listener on a browser `window` (the SSR guard the
// other subscribing composables in this package apply); the vitest env is
// `node`, so define one or every test below would silently exercise the SSR
// path instead of the one it means to. Mirrors the stub in `use-flag.test.ts`.
/* eslint-disable vitest/require-top-level-describe -- the `window` stub is shared by every describe in this file, so it belongs at file scope */
beforeAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
});
/* eslint-enable vitest/require-top-level-describe */

describe(useConnectionStatus, () => {
    it("exposes the current status and updates on every transition", () => {
        const fake = makeFake("idle");
        const { result: status } = withProvidedScope(fake.client, () => useConnectionStatus());

        expect(status.value).toBe("idle");

        fake.emit("connecting");

        expect(status.value).toBe("connecting");

        fake.emit("connected");

        expect(status.value).toBe("connected");
    });

    it("releases the status listener when the scope stops", () => {
        const fake = makeFake("connected");
        const { stop } = withProvidedScope(fake.client, () => useConnectionStatus());

        expect(fake.listenerCount()).toBe(1);

        stop();

        expect(fake.listenerCount()).toBe(0);
    });
});

describe("useConnectionStatus during SSR", () => {
    // `setup()` runs inside `renderToString`, and that render scope is never
    // stopped — so `onScopeDispose` never fires and an unguarded listener stays
    // registered on the client for the lifetime of the server process, one per
    // rendered request.
    it("registers no listener without a browser window, and still reports the current status", () => {
        expect.assertions(2);

        const original = Reflect.getOwnPropertyDescriptor(globalThis, "window");

        Reflect.deleteProperty(globalThis, "window");

        try {
            const fake = makeFake("connected");
            const { result: status } = withProvidedScope(fake.client, () => useConnectionStatus());

            expect(fake.listenerCount()).toBe(0);
            expect(status.value).toBe("connected");
        } finally {
            if (original) {
                Object.defineProperty(globalThis, "window", original);
            }
        }
    });
});
