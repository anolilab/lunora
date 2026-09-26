import type { FunctionReference } from "@lunora/client";
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import useQuery from "../src/use-query";
import { createMockClient } from "./mock-client";

const REF: FunctionReference<"query", Record<string, never>, string> = { __lunoraRef: "messages:mine" };

const View = (): ReactElement => {
    const data = useQuery(REF, {});

    return <div data-testid="view">{data ?? "loading"}</div>;
};

describe("lunoraProvider — swapping the `client` prop", () => {
    it.each([
        ["the provider's own QueryClient", undefined],
        ["a caller-supplied QueryClient", new QueryClient()],
    ])("stops rendering the previous client's rows with %s", async (_label, queryClient) => {
        expect.hasAssertions();

        const a = createMockClient(() => "rows-of-a");
        const b = createMockClient(() => "rows-of-b");
        const tree = (client: typeof a.asClient): ReactNode => (
            <LunoraProvider client={client} queryClient={queryClient}>
                <View />
            </LunoraProvider>
        );
        const view = render(tree(a.asClient));

        await waitFor(() => {
            expect(screen.getByTestId("view").textContent).toBe("rows-of-a");
        });

        view.rerender(tree(b.asClient));

        await waitFor(() => {
            expect(screen.getByTestId("view").textContent).toBe("rows-of-b");
        });

        expect(b.query).toHaveBeenCalledTimes(1);
        expect(b.subscribe).toHaveBeenCalledTimes(1);
    });
});
