import type { OnlineDetector } from "@tanstack/offline-transactions";
import { NonRetriableError } from "@tanstack/offline-transactions";

/** How often the optimistic detector nudges the executor to drain the outbox. */
const OUTBOX_DRAIN_INTERVAL_MS = 1000;

/** A row carrying the Lunora document id. */
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
 *
 * Change detection compares rows by `JSON.stringify`, which is key-order
 * sensitive — safe here because `synced` only ever holds server snapshots, whose
 * column order is stable across reconnects (same query projection). A sync source
 * with unstable key ordering would need a structural compare instead.
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
 * Run a Lunora mutation under the outbox's retry policy.
 *
 * The retryable/permanent split keys on whether the failure carries a server
 * application error `code` (set by `@lunora/client`'s rpc when the server returns
 * a `{ error: { code, … } }` envelope — validation, conflict, etc.). A coded
 * error is a definite verdict: surface it as a `NonRetriableError` so the executor
 * stops and TanStack DB rolls the optimistic insert back. Everything without a
 * code is transient — a `fetch` network failure (`TypeError`) or an HTTP/infra
 * blip the rpc surfaces as a code-less `Error` (a 5xx gateway page, a non-JSON
 * body) — so it's rethrown as-is and the durable outbox replays it. Keying on
 * `error instanceof TypeError` alone would wrongly drop the latter.
 */
export const runOutboxMutation = async (mutate: () => Promise<unknown>): Promise<void> => {
    try {
        await mutate();
    } catch (error) {
        if (typeof (error as { code?: unknown }).code === "string") {
            throw new NonRetriableError(error instanceof Error ? error.message : String(error));
        }

        throw error;
    }
};

/**
 * An "always attempt" online detector. We deliberately don't trust
 * `navigator.onLine`: some environments (and Playwright's `setOffline` under
 * Firefox) leave it stuck, which would freeze the outbox. Instead the executor
 * always tries the send and {@link runOutboxMutation}'s transient-error retry
 * handles real offline; the periodic tick nudges the executor to drain the outbox
 * so a queued write replays promptly once connectivity returns.
 *
 * `isOnline` is therefore intentionally always `true` — it gates the executor's
 * attempts, not a UI signal. A consumer that wants to show real connectivity
 * should read `navigator.onLine` itself, separately from this detector.
 */
export const createOptimisticOnlineDetector = (): OnlineDetector => {
    const intervals = new Set<ReturnType<typeof setInterval>>();

    return {
        dispose: () => {
            for (const handle of intervals) {
                clearInterval(handle);
            }

            intervals.clear();
        },
        isOnline: () => true,
        notifyOnline: () => {
            /* no external online signal — see the comment above */
        },
        subscribe: (callback) => {
            const handle = setInterval(callback, OUTBOX_DRAIN_INTERVAL_MS);

            intervals.add(handle);

            return () => {
                clearInterval(handle);
                intervals.delete(handle);
            };
        },
    };
};
