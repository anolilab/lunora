/* eslint-disable import/exports-last -- a helpers module: public constants/types are declared next to the code they support */
import type { OutboxMutation, OutboxSink } from "@lunora/client";
import type { OnlineDetector } from "@tanstack/offline-transactions";
import { NonRetriableError } from "@tanstack/offline-transactions";

/** How often the optimistic detector nudges the executor to drain the outbox. */
const OUTBOX_DRAIN_INTERVAL_MS = 1000;

/**
 * Reserved `mutationFns` key the unified outbox routes raw `client.mutation`
 * offline writes through. `defineCollections` registers a handler under this
 * name that reads `transaction.metadata` (functionPath + args) and replays the
 * write, so a db app's direct mutations ride the same durable executor as its
 * collection inserts instead of the standalone {@link OutboxSink} fallback.
 */
export const OUTBOX_MUTATION_FN_NAME = "__lunora_outbox__";

/** The metadata an outbox-routed transaction carries so its replay can call `client.mutation`. */
export interface OutboxMutationMetadata extends Record<string, unknown> {
    args: Record<string, unknown>;
    clientId: string;
    functionPath: string;
    /** Stable `${clientId}:${mutationId}` replay key; passed back as the mutation id so a committed-but-unacked replay is server-idempotent. */
    idempotencyKey: string;
    /** Issuing identity fingerprint; the replay handler drops the write when it no longer matches. */
    identity: string | null;
    mutationId: number;
    shardKey?: string;
}

/** A committable outbox transaction handle (the `OfflineTransaction` the executor mints). */
interface OutboxTransaction {
    mutate: (callback: () => void) => unknown;
}

/**
 * The slice of the TanStack `OfflineExecutor` the {@link createExecutorOutboxSink}
 * drives. Declared structurally so `@lunora/db`'s outbox glue doesn't widen its
 * coupling to the executor's full surface (and stays unit-testable with a fake).
 */
export interface OutboxExecutor {
    createOfflineTransaction: (options: {
        autoCommit?: boolean;
        idempotencyKey?: string;
        metadata?: Record<string, unknown>;
        mutationFnName: string;
    }) => OutboxTransaction;
    getPendingCount: () => number;
}

/** Tuning for {@link createExecutorOutboxSink}. */
export interface ExecutorOutboxSinkOptions {
    /** Max persisted-but-unconfirmed writes before `enqueue` rejects with `OFFLINE_QUEUE_OVERFLOW` (default 1000, matching `OfflineQueue`). */
    maxItems?: number;
    /** `mutationFns` key the replay handler is registered under (default {@link OUTBOX_MUTATION_FN_NAME}). */
    mutationFnName?: string;
}

/**
 * The blessed {@link OutboxSink} over the TanStack `OfflineExecutor` — the single
 * durable write path for a `@lunora/db` app. It persists each offline write as an
 * executor transaction carrying the `client.mutation` target in `metadata`, then
 * ports the two semantics the executor lacks vs the built-in `OfflineQueue`.
 *
 * First: a `maxItems` cap that **rejects** a new write at capacity with an
 * `OFFLINE_QUEUE_OVERFLOW`-coded error — the {@link OutboxSink} contract, matching
 * `OfflineQueue`. Rejecting (rather than evicting the oldest) preserves the
 * at-least-once promise: an already-persisted write is never silently dropped, and
 * the caller surfaces back-pressure to the issuing mutation (which rolls its
 * optimistic write back).
 * Second: the identity guard lives in the replay handler (`defineCollections`), which drops a write whose captured `identity` no longer matches — see {@link OutboxMutationMetadata}.
 */
export const createExecutorOutboxSink = (executor: OutboxExecutor, options: ExecutorOutboxSinkOptions = {}): OutboxSink => {
    const maxItems = options.maxItems ?? 1000;
    const mutationFunctionName = options.mutationFnName ?? OUTBOX_MUTATION_FN_NAME;

    return {
        enqueue(mutation: OutboxMutation): Promise<void> {
            // Cap: reject at capacity before persisting, so an already-queued
            // durable write is never silently lost. Mirrors `OfflineQueue` and the
            // `OutboxSink` contract (`OFFLINE_QUEUE_OVERFLOW`).
            if (executor.getPendingCount() >= maxItems) {
                const error = new Error("offline outbox is full") as Error & { code?: string };

                error.code = "OFFLINE_QUEUE_OVERFLOW";

                return Promise.reject(error);
            }

            const metadata: OutboxMutationMetadata = {
                args: mutation.args,
                clientId: mutation.clientId,
                functionPath: mutation.functionPath,
                // Persist the stable replay key so a committed-but-unacked retry
                // resends the same `x-lunora-mutation-id` and the server dedups it.
                idempotencyKey: mutation.idempotencyKey,
                identity: mutation.identity,
                mutationId: mutation.mutationId,
                shardKey: mutation.shardKey,
            };

            // Persist + schedule replay. `autoCommit` flushes on `mutate`, and the
            // empty callback means no collection row is touched — the optimistic
            // update already applied client-side; this transaction is pure transport.
            const transaction = executor.createOfflineTransaction({
                autoCommit: true,
                idempotencyKey: mutation.idempotencyKey,
                metadata,
                mutationFnName: mutationFunctionName,
            });

            transaction.mutate(() => undefined);

            return Promise.resolve();
        },
    };
};

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
 * row. The last-synced base is tracked in `syncedJson`.
 *
 * Change detection compares rows by `JSON.stringify`, which is key-order
 * sensitive — safe here because server snapshots have stable column order
 * across reconnects (same query projection). A sync source with unstable key
 * ordering would need a structural compare instead.
 *
 * `syncedJson` holds the JSON-serialized form of each last-synced row, keyed
 * by row id. It is the **sole** synced-state map — no parallel row-object map
 * is kept. Each incoming value is serialized exactly once per tick (for both
 * comparison and cache update), so the previous value is never re-serialized.
 *
 * Lifecycle: `syncedJson` must be owned by the caller at the same scope as any
 * other per-collection state (e.g. outside the `sync.sync` callback), so the
 * cache persists correctly across sync restarts. A new `makeDiffEmit` closure
 * created on restart receives the same map reference and starts from the
 * committed synced state — no spurious diffs on reconnect.
 */
export const makeDiffEmit =
    <T extends object>(syncedJson: Map<string, string>, writer: SyncWriter<T>) =>
    (next: Map<string, T>): void => {
        writer.begin();

        // Serialize each incoming row once; the string is used for both the
        // change comparison and to repopulate the cache after commit.
        const nextJson = new Map<string, string>();

        for (const [key, value] of next) {
            const valueJson = JSON.stringify(value);

            nextJson.set(key, valueJson);

            if (!syncedJson.has(key)) {
                writer.write({ type: "insert", value });
            } else if (syncedJson.get(key) !== valueJson) {
                writer.write({ type: "update", value });
            }
            // Unchanged row: no write. The cached string equality check replaces
            // the previous JSON.stringify(previous) call, halving serialization work.
        }

        for (const key of syncedJson.keys()) {
            if (!next.has(key)) {
                writer.write({ key, type: "delete" });
            }
        }

        writer.commit();

        // Replace the JSON cache atomically with the new snapshot.
        // All valueJson strings were already computed above — no extra serialization.
        syncedJson.clear();

        for (const [key, valueJson] of nextJson) {
            syncedJson.set(key, valueJson);
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
