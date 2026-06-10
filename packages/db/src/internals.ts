import type { OnlineDetector } from "@tanstack/offline-transactions";
import { NonRetriableError } from "@tanstack/offline-transactions";

/** A row carrying the Cirrus document id. */
export type Row = Record<string, unknown> & { _id: string };

/** The subset of a TanStack DB sync write channel that {@link makeDiffEmit} drives. */
export interface SyncWriter<T extends object> {
    begin: () => void;
    commit: () => void;
    write: (message: { type: "insert" | "update"; value: T } | { key: string; type: "delete" }) => void;
}

/** Index a row list into a keyed map. */
export const toMap = <T extends object>(rows: ReadonlyArray<T>, getKey: (row: T) => string): Map<string, T> => {
    const map = new Map<string, T>();

    for (const row of rows) {
        map.set(getKey(row), row);
    }

    return map;
};

/**
 * Build an `emit(next)` that diffs a desired keyed snapshot into a collection's
 * sync channel — only changed rows are written, so a reconnect snapshot or a
 * scope change never churns the synced view out from under a pending optimistic
 * row. The last-synced base is tracked in `synced`.
 */
export const makeDiffEmit =
    <T extends object>(synced: Map<string, T>, writer: SyncWriter<T>) =>
    (next: Map<string, T>): void => {
        writer.begin();

        for (const [key, value] of next) {
            const previous = synced.get(key);

            if (previous === undefined) {
                writer.write({ type: "insert", value });
            } else if (JSON.stringify(previous) !== JSON.stringify(value)) {
                writer.write({ type: "update", value });
            }
        }

        for (const key of synced.keys()) {
            if (!next.has(key)) {
                writer.write({ key, type: "delete" });
            }
        }

        writer.commit();
        synced.clear();

        for (const [key, value] of next) {
            synced.set(key, value);
        }
    };

/**
 * Run a Cirrus mutation under the outbox's retry policy: a network failure
 * (`TypeError`) stays retryable so the outbox replays it with backoff once the
 * browser is back online; a server rejection becomes a `NonRetriableError` so the
 * executor stops and TanStack DB rolls the optimistic insert back.
 */
export const runOutboxMutation = async (mutate: () => Promise<unknown>): Promise<void> => {
    try {
        await mutate();
    } catch (error) {
        if (error instanceof TypeError) {
            throw error;
        }

        throw new NonRetriableError(error instanceof Error ? error.message : String(error));
    }
};

/**
 * An "always attempt" online detector. We deliberately don't trust
 * `navigator.onLine`: some environments (and Playwright's `setOffline` under
 * Firefox) leave it stuck, which would freeze the outbox. Instead the executor
 * always tries the send and {@link runOutboxMutation}'s network-error retry
 * handles real offline; the periodic tick nudges the executor to drain the outbox
 * so a queued write replays promptly once connectivity returns.
 */
export const createOptimisticOnlineDetector = (): OnlineDetector => {
    let interval: ReturnType<typeof setInterval> | undefined;

    return {
        dispose: () => {
            if (interval) {
                clearInterval(interval);
            }
        },
        isOnline: () => true,
        notifyOnline: () => {
            /* no external online signal — see the comment above */
        },
        subscribe: (callback) => {
            interval = setInterval(callback, 1000);

            return () => {
                if (interval) {
                    clearInterval(interval);
                }
            };
        },
    };
};
