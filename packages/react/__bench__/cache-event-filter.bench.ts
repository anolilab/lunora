import type { QueryCacheNotifyEvent, QueryKey } from "@tanstack/react-query";
import { bench, describe } from "vitest";

import { lunoraQueryKey, serializeQueryKey } from "../src/query-key";

/**
 * `usePaginatedQuery` / `useInfiniteQuery` each subscribe to the *whole*
 * `QueryCache` so a registry-driven `setQueryData` (an `"updated"` event)
 * re-renders the hook. TanStack fires that listener for every cache event
 * across the entire `QueryClient` — `added`, `removed`, `observerAdded`,
 * `observerResultsUpdated`, etc. — and observer-lifecycle events vastly
 * outnumber data writes in a real app (every sibling hook mount/render emits
 * them).
 *
 * The old listener serialized `event.query.queryKey` and scanned every loaded
 * page key (`O(pages)` `JSON.stringify`) on *every* event. The fix early-returns
 * when `event.type !== "updated"`, skipping all serialization on the common
 * non-data events. This bench contrasts the two listener bodies over a
 * realistic event mix.
 */

const makeRef = (ref: string): { __lunoraRef: string } => {
    return { __lunoraRef: ref };
};

// A hook with K loaded pages: the more pages, the more the old listener pays
// per event (it re-serializes each page key in the `.some()` scan).
const PAGE_COUNT = 8;

const pageEntries = Array.from({ length: PAGE_COUNT }, (_, index) => {
    const args = { paginationOpts: { cursor: index === 0 ? null : String(index * 10), numItems: 10 } };
    const key: QueryKey = lunoraQueryKey(makeRef("messages:list"), args, undefined);

    return { key };
});

const pageKeyHashes = new Set(pageEntries.map(({ key }) => serializeQueryKey(key)));

// Build a representative stream of cache events. In a typical app observer
// lifecycle/results events dominate; only a small fraction are the `"updated"`
// data writes the hook actually cares about.
const buildEvents = (): QueryCacheNotifyEvent[] => {
    const events: QueryCacheNotifyEvent[] = [];

    // One of the loaded pages is the target of an actual data write.
    const targetArgs = { paginationOpts: { cursor: null, numItems: 10 } };
    const targetKey: QueryKey = lunoraQueryKey(makeRef("messages:list"), targetArgs, undefined);

    const makeEvent = (queryKey: QueryKey, type: QueryCacheNotifyEvent["type"]): QueryCacheNotifyEvent =>
        ({ query: { queryKey }, type }) as unknown as QueryCacheNotifyEvent;

    for (let index = 0; index < 200; index += 1) {
        const unrelatedKey: QueryKey = ["lunora", `unrelated:q${String(index)}`, {}, null];

        // ~80% non-data events on unrelated/sibling queries, plus one ~20% real
        // data write the hook must react to.
        events.push(
            makeEvent(unrelatedKey, "observerResultsUpdated"),
            makeEvent(unrelatedKey, "observerAdded"),
            makeEvent(unrelatedKey, "observerRemoved"),
            makeEvent(unrelatedKey, "added"),
            makeEvent(targetKey, "updated"),
        );
    }

    return events;
};

const events = buildEvents();

let renders = 0;

// Old listener: serialize + scan on every event regardless of type.
const oldListener = (event: QueryCacheNotifyEvent): void => {
    const hash = serializeQueryKey(event.query.queryKey as QueryKey);

    if (pageKeyHashes.has(hash)) {
        renders += 1;
    }
};

// New listener: early-return on non-data events before any serialization.
const newListener = (event: QueryCacheNotifyEvent): void => {
    if (event.type !== "updated") {
        return;
    }

    const hash = serializeQueryKey(event.query.queryKey as QueryKey);

    if (pageKeyHashes.has(hash)) {
        renders += 1;
    }
};

describe("cache-event listener (paginated/infinite hooks)", () => {
    bench("old: serialize + page-scan on every cache event", () => {
        for (const event of events) {
            oldListener(event);
        }
    });

    bench("new: early-return on non-updated events", () => {
        for (const event of events) {
            newListener(event);
        }
    });
});
