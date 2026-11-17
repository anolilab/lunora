import type { LunoraClient } from "@lunora/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import sharedContext from "../src/shared-context";
import useQuery from "../src/use-query";
import { createMockClient } from "./mock-client";

// An older copy of the provider shares the Lunora client through the registry but publishes neither of the markers this copy
// adds. Recreate that: the Lunora client context is provided inside a plain TanStack provider, and nothing else.
const LunoraClientContext = sharedContext<LunoraClient | null>("lunora-client", null);

const ARGS: Record<string, unknown> = {};

const Display = (): ReactElement => {
    const data = useQuery({ __lunoraRef: "posts:list" }, ARGS);

    return <div data-testid="display">{data === undefined ? "loading" : JSON.stringify(data)}</div>;
};

describe("lunora hooks under a provider from an older copy", () => {
    it("find the visible TanStack client when no marker is published", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });
        const queryClient = new QueryClient();

        render(
            <QueryClientProvider client={queryClient}>
                <LunoraClientContext value={mock.asClient}>
                    <Display />
                </LunoraClientContext>
            </QueryClientProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 1 }));
        });

        expect(queryClient.getQueryCache().findAll({ queryKey: ["lunora"] })).toHaveLength(1);
    });
});
