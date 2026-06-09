import type { FunctionReference } from "@cirrus/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider";
import useSubscription from "../src/use-subscription";
import { createMockClient } from "./mock-client";

const makeRef = (ref: string): FunctionReference => {
    return { __cirrusRef: ref };
};

// Module-level stable default so it isn't recreated as an inline `as` expression
// on every render (react-x/no-unstable-default-props).
const EMPTY_ARGS: Record<string, unknown> = {};

const Display = ({ args = EMPTY_ARGS }: { args?: Record<string, unknown> | "skip" }): ReactElement => {
    const { data, error } = useSubscription(makeRef("messages:list"), args);

    if (error) {
        return <div data-testid="display">error: {error.message}</div>;
    }

    return <div data-testid="display">{data === undefined ? "pending" : JSON.stringify(data)}</div>;
};

describe("useSubscription", () => {
    it("opens a subscription on mount and renders pushed values", async () => {
        expect.hasAssertions();

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

    it('"skip" short-circuits — no subscribe call', () => {
        expect.assertions(2);

        const mock = createMockClient();

        render(
            <CirrusProvider client={mock.asClient}>
                <Display args="skip" />
            </CirrusProvider>,
        );

        expect(mock.subscribe).not.toHaveBeenCalled();
        expect(screen.getByTestId("display").textContent).toBe("pending");
    });

    it("unmount releases the subscription", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const unsubscribeSpy = vi.fn<() => void>();

        // Wrap the mock's subscribe so we can observe the unsubscribe call.
        const originalSubscribe = mock.subscribe.getMockImplementation() as (
            functionRef: FunctionReference,
            args: unknown,
            callback: (value: unknown) => void,
        ) => () => void;

        mock.subscribe.mockImplementation((functionRef, args, callback) => {
            const realUnsubscribe = originalSubscribe(functionRef, args, callback);

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

    it("surfaces a thrown subscribe error", async () => {
        expect.hasAssertions();

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
