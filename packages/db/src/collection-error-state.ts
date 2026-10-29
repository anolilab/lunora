import type { SubscriptionError } from "@lunora/client";

/**
 * What a collection exposes about its subscription's health, as `collection.utils`.
 *
 * A rejected subscription still moves the collection out of `loading` (so it never
 * hangs there), which on its own is indistinguishable from a successful load that
 * found no rows. This is the difference: `isError()` stays true until rows arrive.
 */
export interface LunoraCollectionUtils {
    /** The last subscription error, or `undefined` once rows have arrived since (or before any error). */
    error: () => SubscriptionError | undefined;
    /** Whether the subscription is currently failing. */
    isError: () => boolean;
    /** Listen for the error state changing; returns the unsubscribe. Shaped for `useSyncExternalStore`. */
    subscribeError: (listener: () => void) => () => void;
}

/**
 * The subscription's health: `setError` records (or, given `undefined`, clears) it and
 * notifies listeners; `utils` is the read side exposed on the collection. Created outside
 * `sync.sync` so it outlives a sync restart's callbacks.
 */
export const createErrorState = (): { setError: (next: SubscriptionError | undefined) => void; utils: LunoraCollectionUtils } => {
    let lastError: SubscriptionError | undefined;
    const errorListeners = new Set<() => void>();

    return {
        setError: (next) => {
            if (lastError === next) {
                return;
            }

            lastError = next;

            for (const listener of errorListeners) {
                listener();
            }
        },
        utils: {
            error: () => lastError,
            isError: () => lastError !== undefined,
            subscribeError: (listener) => {
                errorListeners.add(listener);

                return () => {
                    errorListeners.delete(listener);
                };
            },
        },
    };
};
