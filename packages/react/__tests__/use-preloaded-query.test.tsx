import type { Preloaded } from "@cirrus/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider.js";
import { usePreloadedQuery } from "../src/use-preloaded-query.js";
import { createMockClient } from "./mock-client.js";

const preloaded = <T,>(functionPath: string, value: T, args: Record<string, unknown> = {}): Preloaded<T> => {
 return {
    __cirrusPreloaded: true,
    args,
    functionPath,
    value,
};
};

const Display = ({ token }: { token: Preloaded }): ReactElement => {
    const data = usePreloadedQuery(token);

    return <div data-testid="display">{JSON.stringify(data)}</div>;
};

describe("usePreloadedQuery", () => {
    it("renders the preloaded value immediately with no initial HTTP fetch", () => {
        expect.assertions(2);

        // queryImpl returns a sentinel that must never appear — proving no fetch.
        const mock = createMockClient(() => { return { count: 999 }; });

        render(
            <CirrusProvider client={mock.asClient}>
                <Display token={preloaded("posts:list", { count: 1 })} />
            </CirrusProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 1 }));
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("attaches a live subscription so server pushes update the value", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => { return { count: 1 }; });

        render(
            <CirrusProvider client={mock.asClient}>
                <Display token={preloaded("posts:list", { count: 1 })} />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        expect(mock.query).not.toHaveBeenCalled();

        await act(async () => {
            mock.emit("posts:list", { count: 5 });
        });

        // TanStack v5 schedules cache notifications on a microtask, so the
        // post-emit update lands on a later commit — waitFor lets it flush.
        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 5 }));
        });
    });

    it("server-renders the preloaded value (SSR getServerSnapshot, no effects)", () => {
        expect.assertions(3);

        const mock = createMockClient(() => { return { count: 1 }; });

        const view = renderToString(
            <CirrusProvider client={mock.asClient}>
                <Display token={preloaded("posts:list", { count: 42 })} />
            </CirrusProvider>,
        );

        // React HTML-escapes the quotes in the serialized JSON, so decode them
        // before matching the preloaded value the server snapshot produced.
        expect(view.replaceAll("&quot;", '"')).toContain(JSON.stringify({ count: 42 }));
        // No effects run during SSR, so neither transport is touched.
        expect(mock.query).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
    });
});
