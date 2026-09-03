import type { StoredSubscription, SubscriptionFilter, SubscriptionStatus, SubscriptionStore } from "../types";
import { legacyIdFor } from "./normalize";

/** Ascending `id` comparator — pairs with the D1 store's `ORDER BY id ASC`. */
const compareById = (a: StoredSubscription, b: StoredSubscription): number => {
    if (a.id < b.id) {
        return -1;
    }

    return a.id > b.id ? 1 : 0;
};

const matches = (subscription: StoredSubscription, filter?: SubscriptionFilter): boolean => {
    if (filter === undefined) {
        return true;
    }

    if (filter.kind !== undefined && subscription.kind !== filter.kind) {
        return false;
    }

    if (filter.userId !== undefined && (subscription.userId ?? null) !== filter.userId) {
        return false;
    }

    return true;
};

/**
 * An in-memory {@link SubscriptionStore} — the zero-dependency default. Suitable
 * for tests, local dev and a single-isolate app, but **not durable**: entries live
 * only for the isolate's lifetime. Use {@link import("./d1-store").d1SubscriptionStore}
 * (or another backing store) for production so subscriptions survive restarts.
 */
const memorySubscriptionStore = (): SubscriptionStore => {
    const map = new Map<string, StoredSubscription>();

    return {
        delete: (id: string): Promise<void> => {
            map.delete(id);

            return Promise.resolve();
        },
        // Atomic by construction: there is no `await` between the read and the
        // removal, so nothing can replace the row in between.
        deleteOwned: (id: string, userId: string | null): Promise<boolean> => {
            const stored = map.get(id);

            if (stored === undefined || (stored.userId ?? null) !== userId) {
                return Promise.resolve(false);
            }

            map.delete(id);

            return Promise.resolve(true);
        },
        get: (id: string): Promise<StoredSubscription | undefined> => Promise.resolve(map.get(id)),
        list: (filter?: SubscriptionFilter): Promise<StoredSubscription[]> => {
            const result: StoredSubscription[] = [];

            for (const subscription of map.values()) {
                if (matches(subscription, filter)) {
                    result.push(subscription);
                }
            }

            // Keyset-paginate: sort ascending by `id` (Map iteration order is
            // INSERTION order, not `id` order, so this is required for a stable,
            // deterministic page boundary — see `SubscriptionFilter.after`), then
            // drop everything at/before the cursor. Mirrors the D1 store's
            // `ORDER BY id ASC` + `id > ?`.
            result.sort(compareById);

            const paged = filter?.after === undefined ? result : result.filter((subscription) => subscription.id > (filter.after as string));

            // Honor `limit` for parity with the D1 store's `LIMIT` (a non-positive
            // value means "no cap").
            const capped = filter?.limit !== undefined && filter.limit > 0 ? paged.slice(0, Math.trunc(filter.limit)) : paged;

            return Promise.resolve(capped);
        },
        markStatus: (id: string, status: SubscriptionStatus, error?: string): Promise<void> => {
            const existing = map.get(id);

            if (existing !== undefined) {
                map.set(id, { ...existing, lastError: error, lastSeenAt: Date.now(), lastStatus: status });
            }

            return Promise.resolve();
        },
        put: (subscription: StoredSubscription): Promise<StoredSubscription> => {
            // Evict the SAME device's legacy-prefix row (pre-`wp2_`/`fcm2_` 32-bit id)
            // so a device that migrated id schemes isn't held as two rows — otherwise
            // `broadcast` (no id filter) delivers to it twice. Idempotent for parity
            // with the D1 store's legacy delete; the `!== subscription.id` guard keeps
            // a put of a legacy-id row from deleting the very row it just wrote.
            const legacyId = legacyIdFor(subscription);

            if (legacyId !== undefined && legacyId !== subscription.id) {
                map.delete(legacyId);
            }

            const existing = map.get(subscription.id);
            // Preserve the original createdAt on re-register (upsert keeps first-seen time).
            const merged: StoredSubscription = existing === undefined ? subscription : { ...existing, ...subscription, createdAt: existing.createdAt };

            map.set(merged.id, merged);

            return Promise.resolve(merged);
        },
    };
};

// eslint-disable-next-line import/prefer-default-export -- named export by repo convention (no default exports)
export { memorySubscriptionStore };
