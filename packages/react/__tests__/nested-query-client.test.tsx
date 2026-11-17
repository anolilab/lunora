import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import useQuery from "../src/use-query";
import { createMockClient } from "./mock-client";

const ARGS: Record<string, unknown> = {};

const Display = (): ReactElement => {
    const data = useQuery({ __lunoraRef: "posts:list" }, ARGS);

    return <div data-testid="display">{data === undefined ? "loading" : JSON.stringify(data)}</div>;
};

describe("useQuery under a QueryClientProvider nested inside LunoraProvider", () => {
    it("caches the Lunora query in the nested client, where ordinary TanStack queries under it live", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });
        const nested = new QueryClient();

        render(
            <LunoraProvider client={mock.asClient}>
                <QueryClientProvider client={nested}>
                    <Display />
                </QueryClientProvider>
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 1 }));
        });

        expect(nested.getQueryCache().findAll({ queryKey: ["lunora"] })).toHaveLength(1);
    });
});
