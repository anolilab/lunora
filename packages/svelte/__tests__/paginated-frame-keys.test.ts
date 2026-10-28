import type { FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";
import { stableWireKey } from "@lunora/wire";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { paginatedQuery } from "../src/paginated-query";

vi.mock(import("@lunora/wire"), async (importOriginal) => {
    const original = await importOriginal();

    return { ...original, stableWireKey: vi.fn<typeof original.stableWireKey>(original.stableWireKey) };
});

interface SubscribeCall {
    active: boolean;
    args: Record<string, unknown>;
    callback: (data: unknown) => void;
}

const fn = { __lunoraRef: "messages:list" } as FunctionReference;
const NUM_ITEMS = 5;
const PAGE_COUNT = 4;

const rows = (page: number): { id: string }[] =>
    Array.from({ length: NUM_ITEMS }, (_, index) => {
        return { id: `${String(page)}-${String(index)}` };
    });

describe("paginatedQuery frame cost (Svelte)", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("does not re-serialise every page's args on each frame", async () => {
        const calls: SubscribeCall[] = [];
        const client = {
            subscribe: (_function: FunctionReference, args: Record<string, unknown>, callback: (data: unknown) => void): Unsubscribe => {
                const call = { active: true, args, callback };

                calls.push(call);

                return () => {
                    call.active = false;
                };
            },
        } as unknown as LunoraClient;

        const { loadMore, results } = paginatedQuery(client, fn, { channelId: "general" }, { initialNumItems: NUM_ITEMS });
        const stop = results.subscribe(() => {});

        for (let page = 0; page < PAGE_COUNT; page += 1) {
            calls.findLast((call) => call.active)?.callback({ continueCursor: `cur-${String(page + 1)}`, isDone: false, page: rows(page) });
            // eslint-disable-next-line no-await-in-loop -- each page must settle before the next loadMore reads its cursor
            await vi.waitFor(() => undefined);

            if (page < PAGE_COUNT - 1) {
                loadMore(NUM_ITEMS);
                // eslint-disable-next-line no-await-in-loop -- each page must settle before the next loadMore reads its cursor
                await vi.waitFor(() => undefined);
            }
        }

        expect(get(results)).toHaveLength(PAGE_COUNT * NUM_ITEMS);

        const firstPage = calls.find((call) => {
            const options = call.args["paginationOpts"] as { cursor: unknown; endCursor: unknown };

            return call.active && options.cursor === null && options.endCursor === "cur-1";
        });

        vi.mocked(stableWireKey).mockClear();

        for (let frame = 0; frame < 10; frame += 1) {
            firstPage?.callback({ continueCursor: "cur-1", isDone: false, page: rows(0) });
        }

        // A frame rebuilds `pageResults` for every loaded page; the page keys it
        // looks results up by must come from the per-page cache, not a fresh
        // serialisation of each page's args (which was PAGE_COUNT calls per frame).
        expect(stableWireKey).not.toHaveBeenCalled();
        expect(get(results)).toHaveLength(PAGE_COUNT * NUM_ITEMS);

        stop();
    });
});
