import type { StoredSubscription, SubscriptionFilter, SubscriptionStatus, SubscriptionStore } from "../types";

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
        get: (id: string): Promise<StoredSubscription | undefined> => Promise.resolve(map.get(id)),
        list: (filter?: SubscriptionFilter): Promise<StoredSubscription[]> => {
            const result: StoredSubscription[] = [];

            for (const subscription of map.values()) {
                if (matches(subscription, filter)) {
                    result.push(subscription);
                }
            }

            return Promise.resolve(result);
        },
        markStatus: (id: string, status: SubscriptionStatus, error?: string): Promise<void> => {
            const existing = map.get(id);

            if (existing !== undefined) {
                map.set(id, { ...existing, lastError: error, lastSeenAt: Date.now(), lastStatus: status });
            }

            return Promise.resolve();
        },
        put: (subscription: StoredSubscription): Promise<StoredSubscription> => {
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
