import type { AppendInboxInput, InboxItem, InboxStore, ListInboxFilter } from "./types";

/** Descending `id` comparator (newest-first — ids are monotonically increasing, see `nextId`). */
const compareByIdDescending = (a: InboxItem, b: InboxItem): number => {
    if (a.id < b.id) {
        return 1;
    }

    return a.id > b.id ? -1 : 0;
};

/**
 * Zero-pad a monotonically increasing counter into a fixed-width, lexically
 * sortable id. 12 digits comfortably outlives any single isolate's lifetime
 * (10^12 appends) while keeping ids short and diffable in test output.
 */
const nextId = (counter: number): string => `inbox_${counter.toString().padStart(12, "0")}`;

/**
 * An in-memory {@link InboxStore} — the plan 241 spike's ONLY implementation
 * so far (a D1 backend is design-only, see `plans/241-inapp-inbox-design.md`).
 * Mirrors `memorySubscriptionStore`'s shape: not durable, suitable for tests
 * and prototyping the query/receipt surface before committing to a durable
 * schema.
 *
 * ID SCHEME: ids are minted from a per-store monotonically increasing
 * counter (see {@link nextId}), so insertion order and id order always agree
 * — unlike the subscription store's content-hash ids, an inbox item has no
 * natural stable key (an in-app notification isn't "the same" across
 * re-sends the way a device subscription is), so a counter is simpler and
 * sufficient here.
 */
const memoryInboxStore = (): InboxStore => {
    const items: InboxItem[] = [];
    let counter = 0;

    const append = (input: AppendInboxInput): Promise<InboxItem> => {
        counter += 1;

        const item: InboxItem = {
            createdAt: Date.now(),
            id: nextId(counter),
            payload: input.payload,
            userId: input.userId,
            ...(input.category === undefined ? {} : { category: input.category }),
            ...(input.groupKey === undefined ? {} : { groupKey: input.groupKey }),
        };

        items.push(item);

        return Promise.resolve(item);
    };

    const list = (userId: string, filter?: ListInboxFilter): Promise<InboxItem[]> => {
        // Newest-first: ids are monotonically increasing (see `nextId`), so
        // descending id order is descending chronological order.
        let matching = items.filter((item) => item.userId === userId).toSorted(compareByIdDescending);

        if (filter?.unreadOnly === true) {
            matching = matching.filter((item) => item.readAt === undefined);
        }

        // `after` is exclusive and means "strictly OLDER than this cursor" in
        // newest-first order — i.e. a smaller id (see `ListInboxFilter.after`).
        if (filter?.after !== undefined) {
            const { after } = filter;

            matching = matching.filter((item) => item.id < after);
        }

        const capped = filter?.limit !== undefined && filter.limit > 0 ? matching.slice(0, Math.trunc(filter.limit)) : matching;

        return Promise.resolve(capped);
    };

    const unreadCount = (userId: string): Promise<number> => {
        let count = 0;

        for (const item of items) {
            if (item.userId === userId && item.readAt === undefined) {
                count += 1;
            }
        }

        return Promise.resolve(count);
    };

    const markRead = (userId: string, id: string): Promise<void> => {
        // Scoped to `userId` like every sibling operation: an item id is not an
        // authorisation, so an unscoped lookup would let any caller holding one
        // clear another user's notification.
        const item = items.find((candidate) => candidate.id === id && candidate.userId === userId);

        if (item !== undefined && item.readAt === undefined) {
            item.readAt = Date.now();
        }

        return Promise.resolve();
    };

    const markAllRead = (userId: string): Promise<number> => {
        let changed = 0;
        const now = Date.now();

        for (const item of items) {
            if (item.userId === userId && item.readAt === undefined) {
                item.readAt = now;
                changed += 1;
            }
        }

        return Promise.resolve(changed);
    };

    return { append, list, markAllRead, markRead, unreadCount };
};

// eslint-disable-next-line import/prefer-default-export -- named export by repo convention (no default exports)
export { memoryInboxStore };
