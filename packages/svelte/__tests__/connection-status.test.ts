import type { ConnectionStatus, LunoraClient, Unsubscribe } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it } from "vitest";

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
