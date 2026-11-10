import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import useQuery from "../src/use-query";
import { createMockClient } from "./mock-client";

// A copy of TanStack Query whose context the provider's `QueryClientProvider` never reaches. Its exported `useQueryClient`
// throws, as it does for a hook with no provider above it. Lunora's hooks must not depend on that lookup: they get the
// provider's client from the shared registry and pass it to TanStack explicitly.
vi.mock(import("@tanstack/react-query"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("@tanstack/react-query")>();

    return {
        ...actual,
        useQueryClient: (): never => {
            throw new Error("No QueryClient set, use QueryClientProvider to set one");
        },
    };
});

const ARGS: Record<string, unknown> = {};

const Display = (): ReactElement => {
    const data = useQuery({ __lunoraRef: "posts:list" }, ARGS);

    return <div data-testid="display">{data === undefined ? "loading" : JSON.stringify(data)}</div>;
};

describe("useQuery when TanStack's context is not reachable", () => {
    it("still reads through the provider's query client", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 1 }));
        });

        expect(mock.query).toHaveBeenCalledTimes(1);
    });
});
