import type { FunctionReference, SubscriptionError } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import useQuery from "../src/use-query";
import { createMockClient } from "./mock-client";

const makeRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const DEFAULT_ARGS: Record<string, unknown> = {};
const SHARED_ARGS: Record<string, unknown> = { a: 1 };

const Display = ({ args = DEFAULT_ARGS }: { args?: Record<string, unknown> | "skip" }): ReactElement => {
    const data = useQuery(makeRef("posts:list"), args);

    return <div data-testid="display">{data === undefined ? "loading" : JSON.stringify(data)}</div>;
};

const ErrorDisplay = ({ onError }: { onError: (error: SubscriptionError) => void }): ReactElement => {
    // A fresh options object every render — exactly what the ref-backed `onError`
    // wrapper has to tolerate without re-attaching the subscription.
    const data = useQuery(makeRef("posts:list"), DEFAULT_ARGS, { onError });

    return <div data-testid="display">{data === undefined ? "loading" : JSON.stringify(data)}</div>;
};

describe("useQuery", () => {
    it("returns undefined initially, then the resolved value", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe("loading");

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 1 }));
        });

        expect(mock.query).toHaveBeenCalledTimes(1);
    });

    it('"skip" short-circuits the query — no client call', () => {
        expect.assertions(3);

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display args="skip" />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("display").textContent).toBe("loading");
        expect(mock.query).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
    });

    it('"skip" returns undefined even when a sibling filled the shared cache key', async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 7 };
        });

        // Both consumers resolve to the SAME queryKey `["lunora", ref, {}, null]`
        // (a skipped read sets its args to `{}`). The non-skipped sibling fills
        // that cache entry; the skipped one shares the key but must NOT surface
        // the sibling's data — it stays `undefined` ("no network call, no data").
        render(
            <LunoraProvider client={mock.asClient}>
                <Display args={DEFAULT_ARGS} />
                <Display args="skip" />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getAllByTestId("display")[0]?.textContent).toBe(JSON.stringify({ count: 7 }));
        });

        expect(screen.getAllByTestId("display")[1]?.textContent).toBe("loading");
    });

    it("two components sharing args share a single network call", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 2 };
        });

        render(
            <LunoraProvider client={mock.asClient}>
                <Display args={SHARED_ARGS} />
                <Display args={SHARED_ARGS} />
            </LunoraProvider>,
        );

        await waitFor(() => {
            const nodes = screen.getAllByTestId("display");

            expect(nodes).toHaveLength(2);

            for (const node of nodes) {
                expect(node.textContent).toBe(JSON.stringify({ count: 2 }));
            }
        });

        expect(mock.query).toHaveBeenCalledTimes(1);
        expect(mock.subscribe).toHaveBeenCalledTimes(1);
    });

    it("surfaces a server-pushed subscription error through onError", async () => {
        expect.hasAssertions();

        // Regression: `client.subscribe` accepts `onError`, but `useQuery` never
        // forwarded one — a subscription-scoped error the server pushes (an RLS
        // denial, a query that starts failing server-side) had nowhere to go, so
        // the value silently froze at its last good result.
        const mock = createMockClient(() => 0);
        const errors: SubscriptionError[] = [];

        render(
            <LunoraProvider client={mock.asClient}>
                <ErrorDisplay
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness: an inline handler is exactly the identity-churning case the hook must tolerate.
                    onError={(error) => errors.push(error)}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("0");
        });

        await act(async () => {
            mock.emitError("posts:list", { code: "FORBIDDEN", message: "row-level security denied the read" });
        });

        expect(errors).toStrictEqual([{ code: "FORBIDDEN", message: "row-level security denied the read" }]);
    });

    it("wS deltas update the displayed value", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => 0);

        render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("0");
        });

        await act(async () => {
            mock.emit("posts:list", 42);
        });

        // TanStack v5 schedules cache notifications on a microtask, so the
        // post-emit update lands on a later commit — waitFor lets it flush.
        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe("42");
        });
    });

    // The hydration gate (`client.isReady` / `client.whenReady()`), which every
    // other test in this file runs past because the mock reports ready. Both
    // branches are asserted here so removing the gate from `use-query.ts` fails
    // the suite rather than passing it.
    describe("hydration gate", () => {
        it("holds the fetch until whenReady() resolves when the client is not ready yet", async () => {
            expect.hasAssertions();

            const mock = createMockClient(() => {
                return { count: 1 };
            });

            let releaseHydration = (): void => undefined;
            const hydration = new Promise<void>((resolve) => {
                releaseHydration = resolve;
            });

            // `hydrateOnStart`: the durable read cache is still loading, so
            // `isReady` is false until `whenReady()` settles.
            // Spread through a record view: `asClient` is a plain object literal
            // cast to `LunoraClient`, so spreading it loses no prototype — but
            // the cast makes it read as a class instance to the linter.
            const pending = {
                ...(mock.asClient as unknown as Record<string, unknown>),
                isReady: false,
                whenReady: async () => hydration,
            } as unknown as typeof mock.asClient;

            render(
                <LunoraProvider client={pending}>
                    <Display />
                </LunoraProvider>,
            );

            // Nothing may hit the wire while hydration is outstanding — a fetch
            // here is exactly the undefined-flash-then-cached-value the gate exists
            // to prevent.
            await act(async () => undefined);

            expect(mock.query).not.toHaveBeenCalled();

            await act(async () => {
                releaseHydration();
                await hydration;
            });

            await waitFor(() => {
                expect(mock.query).toHaveBeenCalledTimes(1);
            });
        });

        it("seeds the first render from the durable read cache once the client reports ready", () => {
            expect.hasAssertions();

            const mock = createMockClient(() => {
                return { count: 1 };
            });
            const seeded = {
                ...(mock.asClient as unknown as Record<string, unknown>),
                peekHydratedQuery: () => {
                    return { count: 99 };
                },
            } as unknown as typeof mock.asClient;

            render(
                <LunoraProvider client={seeded}>
                    <Display />
                </LunoraProvider>,
            );

            // `initialData: cachedData` — no "loading" frame before the socket
            // round-trip. Unreachable while `isReady` reads `undefined`.
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 99 }));
        });
    });
});
