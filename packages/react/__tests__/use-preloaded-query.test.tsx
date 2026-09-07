import type { Preloaded, SubscriptionErrorCallback } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import usePreloadedQuery, { hydratePreloaded } from "../src/use-preloaded-query";
import { createMockClient } from "./mock-client";

const preloaded = <T,>(functionPath: string, value: T, args: Record<string, unknown> = {}): Preloaded<T> => {
    return {
        __lunoraPreloaded: true,
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
    it("forwards a server-pushed subscription error to onError", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });
        const onError = vi.fn<SubscriptionErrorCallback>();

        const WithError = (): ReactElement => {
            const data = usePreloadedQuery(preloaded("posts:list", { count: 1 }), { onError });

            return <div data-testid="display">{JSON.stringify(data)}</div>;
        };

        render(
            <LunoraProvider client={mock.asClient}>
                <WithError />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
            mock.emitError("posts:list", { code: "UNAUTHORIZED", message: "session expired" });
        });

        // Without this the SSR snapshot keeps rendering as if it were live.
        expect(onError).toHaveBeenCalledWith({ code: "UNAUTHORIZED", message: "session expired" });
    });

    it("renders the preloaded value immediately with no initial HTTP fetch", () => {
        expect.assertions(2);

        // queryImpl returns a sentinel that must never appear — proving no fetch.
        const mock = createMockClient(() => {
            return { count: 999 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display token={preloaded("posts:list", { count: 1 })} />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 1 }));
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("attaches a live subscription so server pushes update the value", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display token={preloaded("posts:list", { count: 1 })} />
            </LunoraProvider>,
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

    it("a live push of null replaces the preloaded value instead of falling back to it", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display token={preloaded("posts:list", { count: 1 })} />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        // The document is deleted / access revoked: the server legitimately
        // re-evaluates the query to `null`. A `data ?? value` fallback would
        // coalesce that `null` back to the stale preloaded `{ count: 1 }` — the
        // deleted post would keep rendering forever. `null` must pass through.
        await act(async () => {
            mock.emit("posts:list", null);
        });

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify(null));
        });
    });

    it("server-renders the preloaded value (SSR getServerSnapshot, no effects)", () => {
        expect.assertions(3);

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        const view = renderToString(
            <LunoraProvider client={mock.asClient}>
                <Display token={preloaded("posts:list", { count: 42 })} />
            </LunoraProvider>,
        );

        // React HTML-escapes the quotes in the serialized JSON, so decode them
        // before matching the preloaded value the server snapshot produced.
        expect(view.replaceAll("&quot;", '"')).toContain(JSON.stringify({ count: 42 }));
        // No effects run during SSR, so neither transport is touched.
        expect(mock.query).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
    });
});

describe("hydratePreloaded (PLAN4 §1 alias)", () => {
    const HydrateDisplay = ({ token }: { token: Preloaded }): ReactElement => {
        const data = hydratePreloaded(token);

        return <div data-testid="hydrate">{JSON.stringify(data)}</div>;
    };

    it("seeds the SSR value on first paint with no loading flash and no fetch", () => {
        expect.assertions(2);

        // A sentinel the query would return if it ran — it must never appear.
        const mock = createMockClient(() => {
            return { count: 999 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <HydrateDisplay token={preloaded("posts:list", { count: 7 })} />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("hydrate").textContent).toBe(JSON.stringify({ count: 7 }));
        expect(mock.query).not.toHaveBeenCalled();
    });

    it("attaches a live subscription after mount so server pushes update the value", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <HydrateDisplay token={preloaded("posts:list", { count: 1 })} />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        expect(mock.query).not.toHaveBeenCalled();

        await act(async () => {
            mock.emit("posts:list", { count: 9 });
        });

        await waitFor(() => {
            expect(screen.getByTestId("hydrate").textContent).toBe(JSON.stringify({ count: 9 }));
        });
    });

    it("server-renders the preloaded value (SSR, no effects, no transport touched)", () => {
        expect.assertions(3);

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        const view = renderToString(
            <LunoraProvider client={mock.asClient}>
                <HydrateDisplay token={preloaded("posts:list", { count: 42 })} />
            </LunoraProvider>,
        );

        expect(view.replaceAll("&quot;", '"')).toContain(JSON.stringify({ count: 42 }));
        expect(mock.query).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
    });
});
