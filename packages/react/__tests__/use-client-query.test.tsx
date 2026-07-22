import type { ClientQueryRef, LunoraClient } from "@lunora/client";
import { createClientQuery } from "@lunora/client";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import useClientQuery from "../src/use-client-query";

/**
 * A minimal `LunoraClient` stand-in exposing just the `*ClientQuery` surface
 * `useClientQuery` touches, with a spy on `subscribeClientQuery` so tests can
 * assert how many times the store subscription opens/closes.
 */
const createFakeClientQueryClient = (): {
    asClient: LunoraClient;
    subscribeCalls: number;
    unsubscribeCalls: number;
} => {
    const values = new Map<string, unknown>();
    const subscribers = new Map<string, Set<(value: unknown) => void>>();
    const counters = { subscribeCalls: 0, unsubscribeCalls: 0 };

    const notify = (key: string, value: unknown): void => {
        for (const callback of subscribers.get(key) ?? []) {
            callback(value);
        }
    };

    const client = {
        getClientQuery: <T,>(ref: ClientQueryRef<T>): T => (values.has(ref.key) ? (values.get(ref.key) as T) : ref.defaultValue),
        setClientQuery: <T,>(ref: ClientQueryRef<T>, value: T): void => {
            if (value === undefined) {
                values.delete(ref.key);
                notify(ref.key, ref.defaultValue);

                return;
            }

            values.set(ref.key, value);
            notify(ref.key, value);
        },
        subscribeClientQuery: (ref: ClientQueryRef, callback: (value: unknown) => void) => {
            counters.subscribeCalls += 1;

            let subs = subscribers.get(ref.key);

            if (!subs) {
                subs = new Set();
                subscribers.set(ref.key, subs);
            }

            subs.add(callback);

            return () => {
                counters.unsubscribeCalls += 1;
                subs.delete(callback);
            };
        },
    };

    return {
        asClient: client as unknown as LunoraClient,
        get subscribeCalls() {
            return counters.subscribeCalls;
        },
        get unsubscribeCalls() {
            return counters.unsubscribeCalls;
        },
    };
};

const sidebarOpen = createClientQuery("sidebarOpen", true);

let renderCount: number;
let setOpenHandle: ((value: boolean) => void) | undefined;

const Display = (): ReactElement => {
    const [open, setOpen] = useClientQuery(sidebarOpen);

    // Tracked in an effect (a side effect, not the render body) so the render
    // count stays observable by the test without reassigning a
    // module-scoped variable during render — that would defeat React
    // Compiler's memoization analysis.
    useEffect(() => {
        renderCount += 1;
    });

    useEffect(() => {
        setOpenHandle = setOpen;
    }, [setOpen]);

    return <div data-testid="display">{String(open)}</div>;
};

describe("useClientQuery", () => {
    beforeEach(() => {
        renderCount = 0;
    });

    it("reads the default synchronously and updates on setClientQuery", () => {
        expect.assertions(2);

        const fake = createFakeClientQueryClient();

        render(
            <LunoraProvider client={fake.asClient}>
                <Display />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe("true");

        act(() => {
            setOpenHandle!(false);
        });

        expect(screen.getByTestId("display").textContent).toBe("false");
    });

    it("keeps the store subscription stable across re-renders (REACT-02 regression)", () => {
        expect.assertions(3);

        const fake = createFakeClientQueryClient();

        const { rerender } = render(
            <LunoraProvider client={fake.asClient}>
                <Display />
            </LunoraProvider>,
        );

        expect(fake.subscribeCalls).toBe(1);

        // Force the component to re-render (props identity unchanged) without
        // touching the store. A stable `subscribe` reference means React never
        // tears down and re-opens the `useSyncExternalStore` subscription.
        rerender(
            <LunoraProvider client={fake.asClient}>
                <Display />
            </LunoraProvider>,
        );
        rerender(
            <LunoraProvider client={fake.asClient}>
                <Display />
            </LunoraProvider>,
        );

        expect(renderCount).toBeGreaterThanOrEqual(3);
        // No additional subscribe/unsubscribe churn across the two extra renders.
        expect(fake.subscribeCalls).toBe(1);
    });
});
