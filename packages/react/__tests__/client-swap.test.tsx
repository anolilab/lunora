import type { FunctionReference, Preloaded } from "@lunora/client";
import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import usePreloadedQuery from "../src/use-preloaded-query";
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

    it("a later sign-out on the previous client leaves the new client's rows alone", async () => {
        expect.hasAssertions();

        const a = createMockClient(() => "rows-of-a");
        const b = createMockClient(() => "rows-of-b");
        const identityListeners = new Set<() => void>();

        (a.asClient as { onIdentityChange: (listener: () => void) => () => void }).onIdentityChange = (listener) => {
            identityListeners.add(listener);

            return () => identityListeners.delete(listener);
        };

        const view = render(
            <LunoraProvider client={a.asClient}>
                <View />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("view").textContent).toBe("rows-of-a");
        });

        view.rerender(
            <LunoraProvider client={b.asClient}>
                <View />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("view").textContent).toBe("rows-of-b");
        });

        await act(async () => {
            for (const listener of identityListeners) {
                listener();
            }

            // TanStack delivers cache updates to observers on a timer.
            await new Promise((resolve) => {
                setTimeout(resolve, 20);
            });
        });

        expect(screen.getByTestId("view").textContent).toBe("rows-of-b");
    });

    it("does not render a preloaded value under a swapped-in client", async () => {
        expect.hasAssertions();

        const token: Preloaded<string> = { __lunoraPreloaded: true, args: {}, functionPath: "messages:mine", value: "preloaded-for-a" };
        const Preload = (): ReactElement => <div data-testid="view">{usePreloadedQuery(token) ?? "loading"}</div>;
        const a = createMockClient(() => "rows-of-a");
        // The new client's read never answers, so only a leftover value could fill the view.
        const b = createMockClient(async () => new Promise<never>(() => {}));
        const view = render(
            <LunoraProvider client={a.asClient}>
                <Preload />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("view").textContent).toBe("preloaded-for-a");

        view.rerender(
            <LunoraProvider client={b.asClient}>
                <Preload />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(b.query).toHaveBeenCalledTimes(1);
        });

        expect(screen.getByTestId("view").textContent).toBe("loading");
    });

    it("does not render a preloaded value in a component that mounts after the swap", async () => {
        expect.hasAssertions();

        const token: Preloaded<string> = { __lunoraPreloaded: true, args: {}, functionPath: "messages:mine", value: "preloaded-for-a" };
        const Preload = (): ReactElement => <div data-testid="view">{usePreloadedQuery(token) ?? "loading"}</div>;
        const a = createMockClient(() => "rows-of-a");
        // The new client's read never answers, so only a leftover value could fill the view.
        const b = createMockClient(async () => new Promise<never>(() => {}));
        const tree = (client: typeof a.asClient, show: boolean): ReactNode => (
            <LunoraProvider client={client}>{show ? <Preload /> : <div data-testid="view">none</div>}</LunoraProvider>
        );
        const view = render(tree(a.asClient, true));

        expect(screen.getByTestId("view").textContent).toBe("preloaded-for-a");

        view.rerender(tree(a.asClient, false));
        view.rerender(tree(b.asClient, false));
        // Mounted under the swapped-in client: its `useState` sees only `b`.
        view.rerender(tree(b.asClient, true));

        await waitFor(() => {
            expect(b.query).toHaveBeenCalledTimes(1);
        });

        expect(screen.getByTestId("view").textContent).toBe("loading");
    });
});
