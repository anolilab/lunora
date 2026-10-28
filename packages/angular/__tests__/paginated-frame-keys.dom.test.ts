import type { FunctionReference } from "@lunora/client";
import { stableWireKey } from "@lunora/wire";
import { describe, expect, it, vi } from "vitest";

import { paginatedQuery } from "../src/paginated-query";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

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

describe("paginatedQuery frame cost (Angular)", () => {
    it("does not re-serialise every page's args on each frame", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const { loadMore, results } = paginatedQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        for (let page = 0; page < PAGE_COUNT; page += 1) {
            fake.subscriptions.findLast((sub) => !sub.unsubscribed)?.push({ continueCursor: `cur-${String(page + 1)}`, isDone: false, page: rows(page) });

            if (page < PAGE_COUNT - 1) {
                loadMore(NUM_ITEMS);
            }
        }

        expect(results()).toHaveLength(PAGE_COUNT * NUM_ITEMS);

        const firstPage = fake.subscriptions.find((sub) => {
            const options = sub.args["paginationOpts"] as { cursor: unknown; endCursor: unknown };

            return !sub.unsubscribed && options.cursor === null && options.endCursor === "cur-1";
        });

        vi.mocked(stableWireKey).mockClear();

        for (let frame = 0; frame < 10; frame += 1) {
            firstPage?.push({ continueCursor: "cur-1", isDone: false, page: rows(0) });
        }

        // A frame rebuilds `pageResults` for every loaded page; the page keys it
        // looks results up by must come from the per-page cache, not a fresh
        // serialisation of each page's args (which was PAGE_COUNT calls per frame).
        expect(stableWireKey).not.toHaveBeenCalled();
        expect(results()).toHaveLength(PAGE_COUNT * NUM_ITEMS);

        destroy.destroy();
    });
});
