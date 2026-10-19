import type { FunctionReference, SubscriptionError } from "@lunora/client";
import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { lunoraQueryKey } from "../src/cache";
import { LunoraProvider } from "../src/lunora-provider";
import { stableWireKey } from "../src/query-key";
import useQuery from "../src/use-query";
import { createMockClient } from "./mock-client";

const makeRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const DEFAULT_ARGS: Record<string, unknown> = {};
const NESTED_ARGS: Record<string, unknown> = { filter: { tags: ["a", "b"], z: 1 }, limit: 10 };
const SHARED_ARGS: Record<string, unknown> = { a: 1 };
// Two DISTINCT objects with identical content — what a re-render produces when
// the args are rebuilt from dependencies that changed without changing the args
// (`Math.min(15, 10)` and `Math.min(20, 10)` are both 10).
const EQUAL_ARGS_FIRST: Record<string, unknown> = { a: 1, limit: 10 };
const EQUAL_ARGS_SECOND: Record<string, unknown> = { a: 1, limit: 10 };

const Display = ({ args = DEFAULT_ARGS, shardKey }: { args?: Record<string, unknown> | "skip"; shardKey?: string }): ReactElement => {
    const data = useQuery(makeRef("posts:list"), args, { shardKey });

    return <div data-testid="display">{data === undefined ? "loading" : JSON.stringify(data)}</div>;
};

const ErrorDisplay = ({ onError }: { onError: (error: SubscriptionError) => void }): ReactElement => {
    // A fresh options object every render — exactly what the ref-backed `onError`
    // wrapper has to tolerate without re-attaching the subscription.
    const data = useQuery(makeRef("posts:list"), DEFAULT_ARGS, { onError });

    return <div data-testid="display">{data === undefined ? "loading" : JSON.stringify(data)}</div>;
};

describe("useQuery", () => {
    it("peeks the hydrated cache with the pre-encoded args key, not the raw args", () => {
        expect.hasAssertions();

        const mock = createMockClient();
        const byKey = vi.spyOn(mock.asClient, "peekHydratedQueryByKey");
        const byArgs = vi.spyOn(mock.asClient, "peekHydratedQuery");
        render(
            <LunoraProvider client={mock.asClient}>
                <Display args={NESTED_ARGS} />
            </LunoraProvider>,
        );

        expect(byKey).toHaveBeenCalledWith("posts:list", stableWireKey(NESTED_ARGS), undefined);
        expect(byArgs).not.toHaveBeenCalled();
    });

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

    it("does not re-subscribe when a re-render produces an equal-but-new args object", async () => {
        expect.hasAssertions();

        // The contract every adapter in this repo shares: the live subscription
        // is keyed on the args' CONTENT, not on object identity. A re-render
        // that rebuilds the args object without changing what it contains must
        // not tear the subscription down and re-snapshot from the server.
        const mock = createMockClient(() => {
            return { count: 3 };
        });

        const { rerender } = render(
            <LunoraProvider client={mock.asClient}>
                <Display args={EQUAL_ARGS_FIRST} />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 3 }));
        });

        expect(mock.subscribe).toHaveBeenCalledTimes(1);

        rerender(
            <LunoraProvider client={mock.asClient}>
                <Display args={EQUAL_ARGS_SECOND} />
            </LunoraProvider>,
        );

        expect(mock.subscribe).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("display").textContent).toBe(JSON.stringify({ count: 3 }));
    });

    it("keeps a skipped hook on the same query key as empty args and renders undefined", () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });
        const queryClient = new QueryClient();

        render(
            <LunoraProvider client={mock.asClient} queryClient={queryClient}>
                <Display args="skip" />
            </LunoraProvider>,
        );

        expect(
            queryClient
                .getQueryCache()
                .findAll()
                .map((query) => query.queryKey),
        ).toStrictEqual([lunoraQueryKey(makeRef("posts:list"), {}, undefined)]);
        expect(screen.getByTestId("display").textContent).toBe("loading");
    });

    it("re-subscribes when shardKey changes between absent and an empty string", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => {
            return { count: 1 };
        });

        const { rerender } = render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(1);
        });

        rerender(
            <LunoraProvider client={mock.asClient}>
                <Display shardKey="" />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(mock.subscribe).toHaveBeenCalledTimes(2);
        });
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

    // With a socket, a mount executes the query once: the subscription's first
    // frame (a full snapshot) resolves the fetch. These replace the old race
    // tests, which refereed an HTTP snapshot against a push for the same key —
    // with no HTTP snapshot, there is nothing to race.
    describe("with a live socket", () => {
        it("resolves from the first push and issues no HTTP query", async () => {
            expect.hasAssertions();

            const mock = createMockClient(() => "http snapshot", { live: true });

            render(
                <LunoraProvider client={mock.asClient}>
                    <Display />
                </LunoraProvider>,
            );

            await waitFor(() => {
                expect(mock.subscribe).toHaveBeenCalledTimes(1);
            });

            expect(screen.getByTestId("display").textContent).toBe("loading");

            await act(async () => {
                mock.emit("posts:list", "seed");
            });

            await waitFor(() => {
                expect(screen.getByTestId("display").textContent).toBe(JSON.stringify("seed"));
            });

            await act(async () => {
                mock.emit("posts:list", "after write");
            });

            await waitFor(() => {
                expect(screen.getByTestId("display").textContent).toBe(JSON.stringify("after write"));
            });

            expect(mock.query).not.toHaveBeenCalled();
        });

        it("falls back to HTTP when the subscription errors before its first value", async () => {
            expect.hasAssertions();

            const mock = createMockClient(() => "http snapshot", { live: true });

            render(
                <LunoraProvider client={mock.asClient}>
                    <Display />
                </LunoraProvider>,
            );

            await waitFor(() => {
                expect(mock.subscribe).toHaveBeenCalledTimes(1);
            });

            await act(async () => {
                mock.emitError("posts:list", { message: "boom" });
            });

            await waitFor(() => {
                expect(screen.getByTestId("display").textContent).toBe(JSON.stringify("http snapshot"));
            });

            expect(mock.query).toHaveBeenCalledTimes(1);
        });

        it("falls back to HTTP when the subscription errors while the hydration gate holds the fetch", async () => {
            expect.hasAssertions();

            const mock = createMockClient(() => "http snapshot", { live: true });

            let releaseHydration = (): void => undefined;
            const hydration = new Promise<void>((resolve) => {
                releaseHydration = resolve;
            });
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

            await waitFor(() => {
                expect(mock.subscribe).toHaveBeenCalledTimes(1);
            });

            // The error lands before any `queryFn` waits on the subscription.
            await act(async () => {
                mock.emitError("posts:list", { message: "boom" });
            });

            await act(async () => {
                releaseHydration();
                await hydration;
            });

            await waitFor(() => {
                expect(screen.getByTestId("display").textContent).toBe(JSON.stringify("http snapshot"));
            });

            expect(mock.query).toHaveBeenCalledTimes(1);
        });

        it("fetches over HTTP on a cross-tab follower whose leader never relays the query", async () => {
            expect.hasAssertions();

            const mock = createMockClient(() => "http snapshot", { follower: true, live: true });

            render(
                <LunoraProvider client={mock.asClient}>
                    <Display />
                </LunoraProvider>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("display").textContent).toBe(JSON.stringify("http snapshot"));
            });

            expect(mock.query).toHaveBeenCalledTimes(1);

            // A frame the leader does relay still updates the follower.
            await act(async () => {
                mock.emit("posts:list", "relayed");
            });

            await waitFor(() => {
                expect(screen.getByTestId("display").textContent).toBe(JSON.stringify("relayed"));
            });
        });

        it("a remount after unmounting mid-wait resolves from the new subscription", async () => {
            expect.hasAssertions();

            const mock = createMockClient(undefined, { live: true });
            const queryClient = new QueryClient({
                defaultOptions: { queries: { gcTime: 5 * 60_000, retry: 0, staleTime: Number.POSITIVE_INFINITY } },
            });
            const tree = (
                <LunoraProvider client={mock.asClient} queryClient={queryClient}>
                    <Display />
                </LunoraProvider>
            );

            // Unmounted before any frame: the waiting fetch is cancelled, not
            // left hanging for the remount to dedupe onto.
            render(tree).unmount();

            render(tree);

            await waitFor(() => {
                expect(mock.subscribe).toHaveBeenCalledTimes(2);
            });

            await act(async () => {
                mock.emit("posts:list", "seed");
            });

            await waitFor(() => {
                expect(screen.getByTestId("display").textContent).toBe(JSON.stringify("seed"));
            });

            expect(mock.query).not.toHaveBeenCalled();
        });
    });

    it("fetches over HTTP when the client has no WebSocket (SSR, no socket)", async () => {
        expect.hasAssertions();

        const mock = createMockClient(() => "http snapshot");

        render(
            <LunoraProvider client={mock.asClient}>
                <Display />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("display").textContent).toBe(JSON.stringify("http snapshot"));
        });

        expect(mock.query).toHaveBeenCalledTimes(1);
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
                peekHydratedQueryByKey: () => {
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
