import type { FunctionReference, SubscriptionErrorCallback } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { usePaginatedQuery } from "../src/use-paginated-query";
import { createMockClient } from "./mock-client";

const makeRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

/** Keyset-style backend over a fixed list, cursor = next offset as a string. */
const makePaginator =
    (items: string[]) =>
    (_ref: string, args: unknown): { continueCursor: null | string; isDone: boolean; page: string[] } => {
        const { paginationOpts } = args as { paginationOpts: { cursor: null | string; numItems: number } };
        const offset = paginationOpts.cursor ? Number(paginationOpts.cursor) : 0;
        const end = offset + paginationOpts.numItems;
        const page = items.slice(offset, end);
        const isDone = end >= items.length;

        return { continueCursor: isDone ? null : String(end), isDone, page };
    };

interface HarnessProps {
    initialNumItems?: number;
    onError?: SubscriptionErrorCallback;
    onLoadMore?: (loadMore: (numberItems: number) => void) => void;
    skip?: boolean;
}

const Harness = ({ initialNumItems: initialNumberItems = 2, onError, onLoadMore, skip = false }: HarnessProps): ReactElement => {
    const { error, isLoading, loadMore, results, status } = usePaginatedQuery(makeRef("items:list"), skip ? "skip" : {}, {
        initialNumItems: initialNumberItems,
        onError,
    });

    onLoadMore?.(loadMore);

    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="loading">{String(isLoading)}</span>
            <span data-testid="results">{(results as string[]).join(",")}</span>
            <span data-testid="error">{error?.message ?? ""}</span>
        </div>
    );
};

/** A paginator that rejects for the page starting at `failAtCursor`, and serves the rest. */
const makeFailingPaginator = (items: string[], failAtCursor: null | string) => {
    const serve = makePaginator(items);

    return (ref: string, args: unknown): { continueCursor: null | string; isDone: boolean; page: string[] } => {
        const { paginationOpts } = args as { paginationOpts: { cursor: null | string } };

        if (paginationOpts.cursor === failAtCursor) {
            throw new Error("page unavailable");
        }

        return serve(ref, args);
    };
};

describe("usePaginatedQuery", () => {
    it("surfaces a first-page failure instead of loading forever", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makeFailingPaginator(["a", "b", "c"], null));
        const onError = vi.fn<SubscriptionErrorCallback>();

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness onError={onError} />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("error").textContent).toBe("page unavailable");
        });

        // The first page has nothing to fall back to, so it stays loading — but
        // the consumer can now see WHY.
        expect(screen.getByTestId("status").textContent).toBe("LoadingFirstPage");
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "page unavailable" }));
    });

    it("drops a failed tail page so the feed leaves LoadingMore and loadMore can retry", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makeFailingPaginator(["a", "b", "c", "d", "e"], "2"));

        let loadMore: (numberItems: number) => void = (_numberItems) => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback used once to capture the hook's `loadMore`.
                    onLoadMore={(next) => {
                        loadMore = next;
                    }}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        act(() => {
            loadMore(2);
        });

        await waitFor(() => {
            expect(screen.getByTestId("error").textContent).toBe("page unavailable");
        });

        // The failed tail is gone: the feed shows what it has and `loadMore` is
        // live again rather than pinned at "LoadingMore" forever.
        expect(screen.getByTestId("results").textContent).toBe("a,b");
        expect(screen.getByTestId("status").textContent).toBe("CanLoadMore");
    });

    it("restarts from the first page when a loaded page's cursor no longer decodes, without reporting it", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));
        const onError = vi.fn<SubscriptionErrorCallback>();
        const stale = { code: "INVALID_CURSOR", message: "invalid cursor" };
        const opts = (args: unknown): { cursor: null | string; endCursor: null | string } =>
            (args as { paginationOpts: { cursor: null | string; endCursor: null | string } }).paginationOpts;
        const sinkFor = (cursor: null | string, endCursor: null | string): SubscriptionErrorCallback | undefined =>
            (mock.subscribe.mock.calls as [unknown, unknown, unknown, { onError?: SubscriptionErrorCallback } | undefined][]).findLast(
                ([, args]) => opts(args).cursor === cursor && opts(args).endCursor === endCursor,
            )?.[3]?.onError;

        let loadMore: (numberItems: number) => void = (_numberItems) => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    onError={onError}
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback used once to capture the hook's `loadMore`.
                    onLoadMore={(next) => {
                        loadMore = next;
                    }}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        act(() => {
            loadMore(2);
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,c,d");
        });

        const tailSink = sinkFor("2", null);

        expect(tailSink).toBeDefined();

        // A deploy changed the cursor format: the re-read of the bounded first page is refused.
        act(() => {
            mock.emitError("items:list", stale, (args) => opts(args).cursor === null && opts(args).endCursor === "2");
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        expect(screen.getByTestId("status").textContent).toBe("CanLoadMore");
        expect(screen.getByTestId("error").textContent).toBe("");

        // The dropped tail reporting the same refusal late changes nothing.
        act(() => {
            tailSink?.(stale);
        });

        expect(screen.getByTestId("results").textContent).toBe("a,b");
        expect(onError).not.toHaveBeenCalled();

        // The head page carries no cursor to be stale, so its refusal is reported, not retried.
        act(() => {
            mock.emitError("items:list", stale, (args) => opts(args).cursor === null && opts(args).endCursor === null);
        });

        await waitFor(() => {
            expect(screen.getByTestId("error").textContent).toBe("invalid cursor");
        });

        expect(onError).toHaveBeenCalledExactlyOnceWith(stale);
    });

    it("restarts once, silently, when every loaded page refuses its cursor in the same burst", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));
        const onError = vi.fn<SubscriptionErrorCallback>();
        const stale = { code: "INVALID_CURSOR", message: "invalid cursor" };

        let loadMore: (numberItems: number) => void = (_numberItems) => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    onError={onError}
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback used once to capture the hook's `loadMore`.
                    onLoadMore={(next) => {
                        loadMore = next;
                    }}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        act(() => {
            loadMore(2);
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,c,d");
        });

        // After a deploy both pages re-read with cursors the server no longer accepts, and both
        // refusals land before React re-renders: the second must not count as a refusal after the restart.
        act(() => {
            mock.emitError("items:list", stale, (args) => {
                const opts = (args as { paginationOpts: { cursor: null | string; endCursor: null | string } }).paginationOpts;

                return opts.cursor !== null || opts.endCursor !== null;
            });
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        expect(onError).not.toHaveBeenCalled();
        expect(screen.getByTestId("error").textContent).toBe("");
    });

    it("reports a second cursor refusal instead of restarting again, when nothing past the head loaded in between", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));
        const onError = vi.fn<SubscriptionErrorCallback>();
        const stale = { code: "INVALID_CURSOR", message: "invalid cursor" };
        const isTail = (args: unknown): boolean => (args as { paginationOpts: { cursor: null | string } }).paginationOpts.cursor === "2";

        let loadMore: (numberItems: number) => void = (_numberItems) => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    onError={onError}
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback used once to capture the hook's `loadMore`.
                    onLoadMore={(next) => {
                        loadMore = next;
                    }}
                />
            </LunoraProvider>,
        );

        const loadTailThenRefuse = async (): Promise<void> => {
            await waitFor(() => {
                expect(screen.getByTestId("status").textContent).toBe("CanLoadMore");
            });

            act(() => {
                loadMore(2);
            });

            // The server refuses the cursor it has just minted, before the tail's first frame lands.
            act(() => {
                mock.emitError("items:list", stale, isTail);
            });
        };

        await loadTailThenRefuse();

        expect(onError).not.toHaveBeenCalled();

        await loadTailThenRefuse();

        await waitFor(() => {
            expect(screen.getByTestId("error").textContent).toBe("invalid cursor");
        });

        expect(onError).toHaveBeenCalledExactlyOnceWith(stale);
    });

    it("lets a page from before a page-size change fail without restarting the new feed", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));
        const stale = { code: "INVALID_CURSOR", message: "invalid cursor" };
        const sink: { current?: SubscriptionErrorCallback } = {};
        // Renders after the hook, in the same pass: the hook has reset for the new page size, but its
        // effects (which detach the old subscriptions) have not run yet.
        const LateFailure = ({ fire }: { fire: boolean }): null => {
            if (fire) {
                sink.current?.(stale);
            }

            return null;
        };
        let loadMore: (numberItems: number) => void = (_numberItems) => undefined;
        const view = (initialNumItems: number, fire: boolean): ReactElement => (
            <LunoraProvider client={mock.asClient}>
                <Harness
                    initialNumItems={initialNumItems}
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback used to capture the hook's `loadMore`.
                    onLoadMore={(next) => {
                        loadMore = next;
                    }}
                />
                <LateFailure fire={fire} />
            </LunoraProvider>
        );
        const { rerender } = render(view(2, false));

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        act(() => {
            loadMore(2);
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,c,d");
        });

        // The bounded first page `(null, "2"]`, which carries a cursor and so would restart the feed.
        sink.current = (mock.subscribe.mock.calls as [unknown, unknown, unknown, { onError?: SubscriptionErrorCallback } | undefined][]).findLast(
            ([, args]) => {
                const opts = (args as { paginationOpts: { cursor: null | string; endCursor: null | string } }).paginationOpts;

                return opts.cursor === null && opts.endCursor === "2";
            },
        )?.[3]?.onError;

        expect(sink.current).toBeDefined();

        rerender(view(3, true));

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,c");
        });

        expect(screen.getByTestId("error").textContent).toBe("");
    });

    it("loads the first page and reports CanLoadMore when more remain", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("status").textContent).toBe("LoadingFirstPage");
        expect(screen.getByTestId("loading").textContent).toBe("true");

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        expect(screen.getByTestId("status").textContent).toBe("CanLoadMore");
        expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    it("loadMore appends pages and reaches Exhausted on the final page", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));

        let loadMore: (numberItems: number) => void = (_numberItems) => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback used once to capture the hook's `loadMore`.
                    onLoadMore={(next) => {
                        loadMore = next;
                    }}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        act(() => {
            loadMore(2);
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,c,d");
        });

        expect(screen.getByTestId("status").textContent).toBe("CanLoadMore");

        act(() => {
            loadMore(2);
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,c,d,e");
        });

        expect(screen.getByTestId("status").textContent).toBe("Exhausted");
        expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    it("loadMore is a no-op once Exhausted", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b"]));

        let loadMore: (numberItems: number) => void = (_numberItems) => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback used once to capture the hook's `loadMore`.
                    onLoadMore={(next) => {
                        loadMore = next;
                    }}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).toBe("Exhausted");
        });

        expect(mock.query).toHaveBeenCalledTimes(1);

        act(() => {
            loadMore(2);
        });

        // No new page request — the single page already covered everything.
        expect(mock.query).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("results").textContent).toBe("a,b");
    });

    it('"skip" short-circuits — no query and stays LoadingFirstPage', () => {
        expect.assertions(4);

        const mock = createMockClient(makePaginator(["a", "b"]));

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness skip />
            </LunoraProvider>,
        );

        expect(mock.query).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
        expect(screen.getByTestId("status").textContent).toBe("LoadingFirstPage");
        expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    it("a WS delta replaces a loaded page in place", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b"]));

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        act(() => {
            mock.emit("items:list", { continueCursor: null, isDone: true, page: ["a", "b", "z"] });
        });

        expect(screen.getByTestId("results").textContent).toBe("a,b,z");
    });
});
