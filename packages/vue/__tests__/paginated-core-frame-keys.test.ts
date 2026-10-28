import { stableWireKey } from "@lunora/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

import { usePaginatedQuery } from "../src/use-paginated-query";
import { createFakeClient } from "./fake-client";

vi.mock(import("@lunora/wire"), async (importOriginal) => {
    const original = await importOriginal();

    return { ...original, stableWireKey: vi.fn<typeof original.stableWireKey>(original.stableWireKey) };
});

const fn = { __lunoraRef: "messages:list" } as Parameters<typeof usePaginatedQuery>[0];
const NUM_ITEMS = 5;
const PAGE_COUNT = 4;

const rows = (page: number): { id: string }[] =>
    Array.from({ length: NUM_ITEMS }, (_, index) => {
        return { id: `${String(page)}-${String(index)}` };
    });

describe("usePaginatedQuery frame cost (Vue)", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("does not re-serialise every page's args on each frame", async () => {
        const fake = createFakeClient();
        const scope = effectScope();
        const result = scope.run(() => fake.provide(() => usePaginatedQuery(fn, { channelId: "general" }, { initialNumItems: NUM_ITEMS })))!;

        for (let page = 0; page < PAGE_COUNT; page += 1) {
            fake.subscribeCalls.at(-1)?.callback({ continueCursor: `cur-${String(page + 1)}`, isDone: false, page: rows(page) });
            // eslint-disable-next-line no-await-in-loop -- each page must settle before the next loadMore reads its cursor
            await nextTick();

            if (page < PAGE_COUNT - 1) {
                result.loadMore(NUM_ITEMS);
                // eslint-disable-next-line no-await-in-loop -- each page must settle before the next loadMore reads its cursor
                await nextTick();
            }
        }

        expect(result.results.value).toHaveLength(PAGE_COUNT * NUM_ITEMS);

        const firstPage = fake.subscribeCalls.find((call) => {
            const options = call.args["paginationOpts"] as { cursor: unknown; endCursor: unknown };

            return options.cursor === null && options.endCursor === "cur-1";
        });

        vi.mocked(stableWireKey).mockClear();

        for (let frame = 0; frame < 10; frame += 1) {
            firstPage?.callback({ continueCursor: "cur-1", isDone: false, page: rows(0) });
        }

        // A frame rebuilds `pageResults` for every loaded page; the page keys it
        // looks results up by must come from the per-page cache, not a fresh
        // serialisation of each page's args (which was PAGE_COUNT calls per frame).
        expect(stableWireKey).not.toHaveBeenCalled();
        expect(result.results.value).toHaveLength(PAGE_COUNT * NUM_ITEMS);

        scope.stop();
    });
});
