import type { ConnectionStatus, LunoraClient, Unsubscribe } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import createConnectionStatus from "../src/create-connection-status";
import { LunoraProvider } from "../src/lunora-provider";

/**
 * Minimal stand-in exposing just the connection-status surface the adapter
 * touches. Records listeners so a test can drive transitions and assert the
 * subscription is released on unmount.
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

describe(createConnectionStatus, () => {
    it("reads the current status and updates on every transition", () => {
        const fake = makeFake("idle");

        const { container } = render(
            () => {
                const status = createConnectionStatus();

                return <pre>{status()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        expect(container.textContent).toBe("idle");

        fake.emit("connecting");

        expect(container.textContent).toBe("connecting");

        fake.emit("connected");

        expect(container.textContent).toBe("connected");
    });

    it("releases the status listener on unmount", () => {
        const fake = makeFake("connected");

        const { unmount } = render(
            () => {
                createConnectionStatus();

                return <pre />;
            },
            { wrapper: (props) => <LunoraProvider client={fake.client}>{props.children}</LunoraProvider> },
        );

        expect(fake.listenerCount()).toBe(1);

        unmount();

        expect(fake.listenerCount()).toBe(0);
    });
});
