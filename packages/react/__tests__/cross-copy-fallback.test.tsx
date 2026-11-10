import type { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { createContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockClient } from "./mock-client";

// The provider's copy uses TanStack's real `QueryClientContext`. The hook's copy gets a `QueryClientContext` of its own, which no
// provider reaches, so its hooks can only find the client through the shared registry. That is the fallback this test covers.
describe("lunora hooks whose copy cannot see the provider's TanStack context", () => {
    // The TanStack mock is for this test alone: later tests in the file must import the real module.
    afterEach(() => {
        vi.doUnmock(import("@tanstack/react-query"));
        vi.resetModules();
    });

    it("reach the provider's client through the shared registry", async () => {
        expect.hasAssertions();

        vi.resetModules();
        const providerCopy = await import("../src/lunora-provider");

        vi.resetModules();
        vi.doMock(import("@tanstack/react-query"), async (importOriginal) => {
            const actual = await importOriginal();

            return {
                ...actual,
                QueryClientContext: createContext<QueryClient | undefined>(undefined),
            };
        });
        const hookCopy = await import("../src/use-query");

        const mock = createMockClient(() => {
            return { count: 1 };
        });
        const ARGS: Record<string, unknown> = {};

        const Display = (): ReactElement => {
            const data = hookCopy.default({ __lunoraRef: "posts:list" }, ARGS);

            return <div data-testid="display">{data === undefined ? "loading" : JSON.stringify(data)}</div>;
        };

        render(
            <providerCopy.LunoraProvider client={mock.asClient}>
                <Display />
            </providerCopy.LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 1 }));
        });

        expect(mock.query).toHaveBeenCalledTimes(1);
    });
});
