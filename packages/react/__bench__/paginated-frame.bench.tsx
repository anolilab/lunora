// @vitest-environment jsdom
import type { FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";
import { notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { bench, describe } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import Feed from "./paginated-feed";

/**
 * One live frame on the head page of a 20-page feed (25 rows each), from the
 * subscription callback to a committed render. Every frame re-renders the whole
 * feed, so whatever the hook derives per loaded page is paid here.
 */

const PAGE_COUNT = 20;
const NUM_ITEMS = 25;
const ITEMS = Array.from({ length: PAGE_COUNT * NUM_ITEMS }, (_v, index) => `item_${index.toString().padStart(6, "0")}`);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler((callback) => {
    callback();
});

interface PaginationOpts {
    cursor: null | string;
    endCursor?: null | string;
    numItems: number;
}

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

const client = {
    expectsPush: () => true,
    getAuthToken: () => null,
    // No socket implementation selects the HTTP `query` fallback for the page fetches; pushes still arrive through `subscribe`.
    getWebSocketImpl: () => undefined,
    isCrossTabFollower: () => false,
    onAuthTokenChange: (): Unsubscribe => () => undefined,
    onConnectionStatus: (): Unsubscribe => () => undefined,
    onIdentityChange: (): Unsubscribe => () => undefined,
    query: async (_reference: FunctionReference, args: unknown) => evaluate((args as { paginationOpts: PaginationOpts }).paginationOpts),
    subscribe: (_reference: FunctionReference, args: unknown, callback: (value: unknown) => void): Unsubscribe => {
        const sub = { callback, opts: (args as { paginationOpts: PaginationOpts }).paginationOpts };

        subs.push(sub);
        callback(evaluate(sub.opts));

        return () => {
            subs.splice(subs.indexOf(sub), 1);
        };
    },
} as unknown as LunoraClient;

const feed: { current: { loaded: number; loadMore: (numberItems: number) => void } | null } = { current: null };
const root = createRoot(document.createElement("div"));

await act(async () => {
    root.render(
        <LunoraProvider client={client}>
            <Feed handleRef={feed} numItems={NUM_ITEMS} />
        </LunoraProvider>,
    );
});

while ((feed.current?.loaded ?? 0) < ITEMS.length) {
    // eslint-disable-next-line no-await-in-loop -- each page must land before the next loadMore reads its cursor
    await act(async () => {
        feed.current?.loadMore(NUM_ITEMS);
    });
}

const head = subs.find((sub) => sub.opts.cursor === null)!;

describe("usePaginatedQuery: one frame on a 20-page feed", () => {
    bench("head-page frame", () => {
        act(() => {
            head.callback(evaluate(head.opts));
        });
    });
});
