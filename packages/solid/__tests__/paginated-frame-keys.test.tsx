import type { FunctionReference } from "@lunora/client";
import { stableWireKey } from "@lunora/wire";
import { render } from "@solidjs/testing-library";
import { assert, describe, expect, it, vi } from "vitest";

import { createPaginatedQuery } from "../src/create-paginated-query";
import { LunoraProvider } from "../src/lunora-provider";
import { createFakeClient } from "./fake-client";

vi.mock(import("@lunora/wire"), async (importOriginal) => {
    const original = await importOriginal();

    return { ...original, stableWireKey: vi.fn<typeof original.stableWireKey>(original.stableWireKey) };
});

const fn = { __lunoraRef: "messages:list" } as FunctionReference;
const NUM_ITEMS = 5;
const PAGE_COUNT = 4;

const rows = (page: number): { id: string }[] =>
    Array.from({ length: NUM_ITEMS }, (_, index) => {
        return { id: `${String(page)}-${String(index)}` };
    });

describe("createPaginatedQuery frame cost (Solid)", () => {
    it("does not re-serialise every page's args on each frame", async () => {
        const fake = createFakeClient();
        let feed: ReturnType<typeof createPaginatedQuery> | undefined;

        render(
            () => {
                feed = createPaginatedQuery(fn, { channelId: "general" }, { initialNumItems: NUM_ITEMS });

                return <pre>{feed.status()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        for (let page = 0; page < PAGE_COUNT; page += 1) {
            fake.subscriptions.findLast((sub) => !sub.unsubscribed)?.push({ continueCursor: `cur-${String(page + 1)}`, isDone: false, page: rows(page) });
            // eslint-disable-next-line no-await-in-loop -- each page must settle before the next loadMore reads its cursor
            await vi.waitFor(() => {
                expect(feed?.results()).toHaveLength((page + 1) * NUM_ITEMS);
            });

            if (page < PAGE_COUNT - 1) {
                feed?.loadMore(NUM_ITEMS);
                // eslint-disable-next-line no-await-in-loop -- each page must settle before the next loadMore reads its cursor
                await vi.waitFor(() => {
                    if (fake.subscriptions.filter((sub) => !sub.unsubscribed).length !== page + 2) {
                        throw new Error("the pinned page has not been replaced yet");
                    }
                });
            }
        }

        expect(feed?.results()).toHaveLength(PAGE_COUNT * NUM_ITEMS);

        const firstPage = fake.subscriptions.find((sub) => {
            const options = sub.args["paginationOpts"] as { cursor: unknown; endCursor: unknown };

            return !sub.unsubscribed && options.cursor === null && options.endCursor === "cur-1";
        });

        assert(firstPage, "first page subscription not found");

        vi.mocked(stableWireKey).mockClear();

        for (let frame = 0; frame < 10; frame += 1) {
            firstPage.push({ continueCursor: "cur-1", isDone: false, page: rows(0) });
        }

        // A frame rebuilds `pageResults` for every loaded page; the page keys it
        // looks results up by must come from the per-page cache, not a fresh
        // serialisation of each page's args (which was PAGE_COUNT calls per frame).
        expect(stableWireKey).not.toHaveBeenCalled();
        expect(feed?.results()).toHaveLength(PAGE_COUNT * NUM_ITEMS);
    });
});
