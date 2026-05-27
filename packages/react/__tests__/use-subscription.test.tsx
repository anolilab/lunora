import type { FunctionReference } from "@cirrus/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider.js";
import { useSubscription } from "../src/use-subscription.js";
import { createMockClient } from "./mock-client.js";

const fn = (ref: string): FunctionReference => ({ __cirrusRef: ref });

const Display = ({ args = {} as Record<string, unknown> }: { args?: Record<string, unknown> | "skip" }): ReactElement => {
    const { data, error } = useSubscription(fn("messages:list"), args as Record<string, unknown> | "skip");

    if (error) {
        return <div data-testid="display">error: {error.message}</div>;
    }

    return <div data-testid="display">{data === undefined ? "pending" : JSON.stringify(data)}</div>;
};

describe("useSubscription", () => {
    test("opens a subscription on mount and renders pushed values", async () => {
        const mock = createMockClient();

        render(
            <CirrusProvider client={mock.asClient}>
                <Display />
            </CirrusProvider>,
        );

        // No initial HTTP fetch — only the WS subscribe.
        expect(mock.query).not.toHaveBeenCalled();

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        expect(screen.getByTestId("display").textContent).toBe("pending");

        await act(async () => {
            mock.emit("messages:list", { count: 7 });
        });

        expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 7 }));
    });

    test('"skip" short-circuits — no subscribe call', () => {
        const mock = createMockClient();

        render(
            <CirrusProvider client={mock.asClient}>
                <Display args="skip" />
            </CirrusProvider>,
        );

        expect(mock.subscribe).not.toHaveBeenCalled();
        expect(screen.getByTestId("display").textContent).toBe("pending");
    });

    test("unmount releases the subscription", async () => {
        const mock = createMockClient();
        const unsubscribeSpy = vi.fn();

        // Wrap the mock's subscribe so we can observe the unsubscribe call.
        const originalSubscribe = mock.subscribe.getMockImplementation() as (
            fnRef: FunctionReference,
            args: unknown,
            cb: (value: unknown) => void,
        ) => () => void;

        mock.subscribe.mockImplementation((fnRef, args, cb) => {
            const realUnsubscribe = originalSubscribe(fnRef, args, cb);

            return () => {
                unsubscribeSpy();
                realUnsubscribe();
            };
        });

        const view = render(
            <CirrusProvider client={mock.asClient}>
                <Display />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        view.unmount();

        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    test("surfaces a thrown subscribe error", async () => {
        const mock = createMockClient();

        mock.subscribe.mockImplementationOnce(() => {
            throw new Error("subscribe boom");
        });

        render(
            <CirrusProvider client={mock.asClient}>
                <Display />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("error: subscribe boom");
        });
    });
});
