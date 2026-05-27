import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import type { FunctionReference } from "@cirrus/client";
import type { ReactElement } from "react";
import { CirrusProvider } from "../src/CirrusProvider.js";
import { useQuery } from "../src/useQuery.js";
import { createMockClient } from "./mockClient.js";

const fn = (ref: string): FunctionReference => ({ __cirrusRef: ref });

const Display = ({ args = {} as Record<string, unknown> }: { args?: Record<string, unknown> | "skip" }): ReactElement => {
    const data = useQuery(fn("posts:list"), args as Record<string, unknown> | "skip");

    return <div data-testid="display">{data === undefined ? "loading" : JSON.stringify(data)}</div>;
};

describe("useQuery", () => {
    test("returns undefined initially, then the resolved value", async () => {
        const mock = createMockClient(() => ({ count: 1 }));

        render(
            <CirrusProvider client={mock.asClient}>
                <Display />
            </CirrusProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe("loading");

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 1 }));
        });

        expect(mock.query).toHaveBeenCalledOnce();
    });

    test('"skip" short-circuits the query — no client call', () => {
        const mock = createMockClient(() => ({ count: 1 }));

        render(
            <CirrusProvider client={mock.asClient}>
                <Display args="skip" />
            </CirrusProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe("loading");
        expect(mock.query).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
    });

    test("two components sharing args share a single network call", async () => {
        const mock = createMockClient(() => ({ count: 2 }));

        render(
            <CirrusProvider client={mock.asClient}>
                <Display args={{ a: 1 }} />
                <Display args={{ a: 1 }} />
            </CirrusProvider>,
        );

        await waitFor(() => {
            const nodes = screen.getAllByTestId("display");

            expect(nodes).toHaveLength(2);
            for (const node of nodes) {
                expect(node.textContent).toBe(JSON.stringify({ count: 2 }));
            }
        });

        expect(mock.query).toHaveBeenCalledOnce();
        expect(mock.subscribe).toHaveBeenCalledOnce();
    });

    test("WS deltas update the displayed value", async () => {
        const mock = createMockClient(() => 0);

        render(
            <CirrusProvider client={mock.asClient}>
                <Display />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("0");
        });

        await act(async () => {
            mock.emit("posts:list", 42);
        });

        expect(screen.getByTestId("display").textContent).toBe("42");
    });
});
