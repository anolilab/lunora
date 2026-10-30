import type { FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { lunoraQueryKey } from "../src/cache";
import { LunoraProvider } from "../src/lunora-provider";
import { usePaginatedQuery } from "../src/use-paginated-query";

vi.mock(import("../src/cache"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, lunoraQueryKey: vi.fn<typeof actual.lunoraQueryKey>(actual.lunoraQueryKey) };
});

interface PaginationOpts {
    cursor: null | string;
    endCursor?: null | string;
    numItems: number;
}

const ITEMS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const NUM_ITEMS = 2;
const PAGE_COUNT = 4;

const evaluate = ({ cursor, endCursor, numItems }: PaginationOpts): unknown => {
    const after = cursor === null ? ITEMS : ITEMS.filter((value) => value > cursor);

    if (endCursor != null) {
        return { continueCursor: endCursor, isDone: true, page: after.filter((value) => value <= endCursor), splitCursor: null };
    }

    const page = after.slice(0, numItems);
    const isDone = after.length <= numItems;

    return { continueCursor: isDone ? null : (page.at(-1) ?? null), isDone, page };
};

const subs: { callback: (value: unknown) => void; opts: PaginationOpts }[] = [];
/** Each subscription's first delivery: the milestone a page waits on instead of polling the DOM. */
const deliveries: Promise<void>[] = [];

const client = {
    expectsPush: () => true,
    getAuthToken: vi.fn<() => string | null>(() => null),
    getWebSocketImpl: () => undefined,
    isCrossTabFollower: () => false,
    onAuthTokenChange: vi.fn<() => Unsubscribe>(() => () => undefined),
    onConnectionStatus: vi.fn<() => Unsubscribe>(() => () => undefined),
    onIdentityChange: vi.fn<() => Unsubscribe>(() => () => undefined),
    query: vi.fn<(reference: FunctionReference, args: unknown) => Promise<unknown>>(async (_reference, args) =>
        evaluate((args as { paginationOpts: PaginationOpts }).paginationOpts),
    ),
    subscribe: vi.fn<(reference: FunctionReference, args: unknown, callback: (value: unknown) => void) => Unsubscribe>((_reference, args, callback) => {
        const sub = { callback, opts: (args as { paginationOpts: PaginationOpts }).paginationOpts };

        subs.push(sub);
        deliveries.push(
            new Promise<void>((resolve) => {
                queueMicrotask(() => {
                    callback(evaluate(sub.opts));
                    resolve();
                });
            }),
        );

        return () => {
            subs.splice(subs.indexOf(sub), 1);
        };
    }),
} as unknown as LunoraClient;

const harness: { loadMore?: (numberItems: number) => void; renders: number } = { renders: 0 };

const Feed = (): ReactElement => {
    // An inline args object, as callers write it: a fresh identity every render.
    const result = usePaginatedQuery({ __lunoraRef: "items:list" }, { channel: "general" }, { initialNumItems: NUM_ITEMS });

    // One commit per render here (no StrictMode, no concurrent features), so this counts renders without a render-phase write.
    useEffect(() => {
        harness.renders += 1;
        harness.loadMore = result.loadMore;
    });

    return <span data-testid="results">{(result.results as string[]).join(",")}</span>;
};

describe("usePaginatedCore — render cost", () => {
    it("does not rebuild every page key on each frame", async () => {
        expect.hasAssertions();

        render(
            <LunoraProvider client={client}>
                <Feed />
            </LunoraProvider>,
        );

        for (let page = 1; page <= PAGE_COUNT; page += 1) {
            // eslint-disable-next-line no-await-in-loop -- each page must land before the next loadMore reads its cursor
            await act(async () => {
                await Promise.all(deliveries.splice(0));
            });

            expect(screen.getByTestId("results").textContent).toBe(ITEMS.slice(0, page * NUM_ITEMS).join(","));

            if (page < PAGE_COUNT) {
                act(() => {
                    harness.loadMore?.(NUM_ITEMS);
                });
            }
        }

        const head = subs.find((sub) => sub.opts.cursor === null)!;
        const buildKey = vi.mocked(lunoraQueryKey);

        buildKey.mockClear();
        harness.renders = 0;

        for (let frame = 0; frame < 10; frame += 1) {
            act(() => {
                head.callback(evaluate(head.opts));
            });
        }

        expect(harness.renders).toBeGreaterThan(0);
        // One key per render is the reset-key check over the base args; the
        // PAGE_COUNT page keys must come from the per-page cache.
        expect(buildKey).toHaveBeenCalledTimes(harness.renders);
    });
});
