import type { FunctionReference } from "@cirrus/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider.js";
import { useQuery } from "../src/use-query.js";
import { createMockClient } from "./mock-client.js";

const fn = (reference: string): FunctionReference => ({ __cirrusRef: reference });

const Display = (): ReactElement => {
    const value = useQuery(fn("posts:list"), {});
    const qc = useQueryClient();

    // We expose the queryClient identity via a data-* attribute so we can
    // assert the BYO client is the one in use without depending on `===`
    // semantics across hooks (the public surface is opaque).
    return (
        <div data-qc-defaults={JSON.stringify(qc.getDefaultOptions().queries ?? {})} data-testid="display">
            {value === undefined ? "pending" : JSON.stringify(value)}
        </div>
    );
};

describe("cirrusProvider — bring-your-own QueryClient", () => {
    test("uses an explicit queryClient prop instead of creating one", async () => {
        const mock = createMockClient(() => ({ count: 7 }));
        const myQc = new QueryClient({ defaultOptions: { queries: { gcTime: 99, retry: 0 } } });

        render(
            <CirrusProvider client={mock.asClient} queryClient={myQc}>
                <Display />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 7 }));
        });

        const defaults = JSON.parse(screen.getByTestId("display").dataset.qcDefaults ?? "{}");

        expect(defaults.gcTime).toBe(99);
    });

    test("inherits the QueryClient from a parent <QueryClientProvider> without double-wrapping", async () => {
        const mock = createMockClient(() => ({ count: 3 }));
        const parentQc = new QueryClient({ defaultOptions: { queries: { gcTime: 12_345, retry: 0 } } });

        render(
            <QueryClientProvider client={parentQc}>
                <CirrusProvider client={mock.asClient}>
                    <Display />
                </CirrusProvider>
            </QueryClientProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 3 }));
        });

        const defaults = JSON.parse(screen.getByTestId("display").dataset.qcDefaults ?? "{}");

        // The marker for "we used the parent client" — its non-default gcTime
        // shows through the hook's useQueryClient() lookup.
        expect(defaults.gcTime).toBe(12_345);
    });

    test("creates a default QueryClient when none is provided", async () => {
        const mock = createMockClient(() => ({ count: 1 }));

        render(
            <CirrusProvider client={mock.asClient}>
                <Display />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 1 }));
        });

        const defaults = JSON.parse(screen.getByTestId("display").dataset.qcDefaults ?? "{}");

        // Default settings from createDefaultQueryClient.
        expect(defaults.retry).toBe(0);
        // staleTime: Infinity does not survive JSON.stringify (Infinity → null);
        // but the absence of `cacheTime` being 0 demonstrates a real client was created.
        expect(defaults).toMatchObject({ gcTime: 5 * 60_000, retry: 0 });
    });
});
