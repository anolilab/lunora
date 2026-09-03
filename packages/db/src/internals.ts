/* eslint-disable import/exports-last -- a helpers module: public constants/types are declared next to the code they support */
import type { OutboxMutation, OutboxSink } from "@lunora/client";
import type { Collection } from "@tanstack/db";
import { createCollection, safeRandomUUID } from "@tanstack/db";
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

/**
 * Provenance stamped on a durable write at enqueue time: the two questions a
 * replay cannot answer from the persisted row once the write outlives the
 * session that made it — WHO queued it, and WHICH shard it belongs to.
 *
 * Shared so both replay paths (`db.actions.*` and the reserved
 * `__lunora_outbox__` handler) check the same fields; they drifted apart once
 * already, and only one of them had the identity guard.
 */
export interface WriteProvenance extends Record<string, unknown> {
    /** Issuing identity fingerprint; a replay drops the write when it no longer matches. */
    identity: string | null;
    /** Captured, not re-read at replay: a queued write follows the shard it was made against even if the app reboots pointed at another. */
    shardKey?: string;
}

/** The metadata an outbox-routed transaction carries so its replay can call `client.mutation`. */
export interface OutboxMutationMetadata extends WriteProvenance {
    args: Record<string, unknown>;
    clientId: string;
    functionPath: string;
    /** Stable `${clientId}:${mutationId}` replay key; passed back as the mutation id so a committed-but-unacked replay is server-idempotent. */
    idempotencyKey: string;
    mutationId: number;
}

/** A committable outbox transaction handle (the `OfflineTransaction` the executor mints). */
interface OutboxTransaction {
    commit?: () => Promise<unknown>;
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

/**
 * Executor → its transport-carrier collection (see {@link createOutboxCarrier}).
 * Populated by `defineCollections` at wiring time; read by
 * {@link createExecutorOutboxSink} when it persists a raw write.
 */
const outboxCarriers = new WeakMap<OutboxExecutor, Collection<Row, string>>();

/**
 * Create the internal "carrier" collection outbox-routed transactions ride on.
 *
 * TanStack's `Transaction.commit()` short-circuits a transaction with zero
 * collection mutations — it completes WITHOUT invoking the mutationFn, so a
 * metadata-only "pure transport" transaction would never be persisted and never
 * replayed (the offline write silently vanishes). The sink therefore records one
 * synthetic row per raw write on this collection, which makes the transaction
 * real for the executor while staying invisible to the app: the row is
 * optimistic-only and is dropped as soon as the transaction settles (there is no
 * synced row to supersede it), and the collection is registered under the
 * reserved {@link OUTBOX_MUTATION_FN_NAME} key so persisted transactions
 * serialize/deserialize across reloads.
 *
 * The collection id carries a per-instance suffix (multiple data layers may
 * coexist in one process); the executor's registry key — what the serializer
 * persists — stays the stable reserved name.
 */
export const createOutboxCarrier = (): Collection<Row, string> =>
    createCollection<Row, string>({
        getKey: (row) => row._id,
        id: `${OUTBOX_MUTATION_FN_NAME}:${safeRandomUUID()}`,
        startSync: true,
        sync: {
            // Nothing syncs into the carrier — mark it ready immediately.
            sync: (writer) => {
                writer.markReady();

                return () => undefined;
            },
        },
    });

/** Associate an executor with its transport carrier (called by `defineCollections`). */
export const registerOutboxCarrier = (executor: OutboxExecutor, carrier: Collection<Row, string>): void => {
    outboxCarriers.set(executor, carrier);
};

/** One-time dev signal when the sink runs against an executor without a carrier. */
let warnedMissingCarrier = false;

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

            const carrier = outboxCarriers.get(executor);

            if (!carrier && !warnedMissingCarrier) {
                warnedMissingCarrier = true;

                // eslint-disable-next-line no-console
                console.warn(
                    "[@lunora/db] createExecutorOutboxSink: no outbox carrier is registered for this executor. " +
                        "On a TanStack OfflineExecutor a zero-mutation transaction is silently dropped, so offline " +
                        "writes may be lost — wire the sink to the executor returned by defineCollections().",
                );
            }

            // Persist + schedule replay. The transaction is pure transport — the
            // optimistic update already applied client-side — but it must not be
            // EMPTY: TanStack's `Transaction.commit()` completes a zero-mutation
            // transaction without ever invoking its mutationFn, which would drop
            // the write. The synthetic carrier row keeps the transaction real; it
            // is optimistic-only and vanishes once the transaction settles.
            const transaction = executor.createOfflineTransaction({
                autoCommit: false,
                idempotencyKey: mutation.idempotencyKey,
                metadata,
                mutationFnName: mutationFunctionName,
            });

            transaction.mutate(() => {
                carrier?.insert({ _id: mutation.idempotencyKey });
            });

            // Commit explicitly (not via `autoCommit`, whose upstream failure
            // handler rethrows inside its own .catch — every terminal verdict
            // would surface as an unhandled rejection) and swallow the outcome:
            // retries are the executor's job and permanent drops are reported
            // through the replay handler / `onWriteRejected`, not this promise.
            transaction.commit?.().catch(() => undefined);

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
export const toMap = <T extends object>(rows: ReadonlyArray<T>, getKey: (row: T) => string): Map<string, T> =>
    new Map(rows.map((row): [string, T] => [getKey(row), row]));

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
            const nonRetriable = new NonRetriableError(error instanceof Error ? error.message : String(error));

            // Carry the server's machine-readable `code` through to the executor so
            // an `onWriteRejected` consumer can branch on it (CONFLICT vs FORBIDDEN
            // vs …) exactly like the client's `MutationSettledEvent` — otherwise the
            // verdict would be flattened to a message-only error.
            (nonRetriable as Error & { code?: string }).code = (error as { code: string }).code;

            throw nonRetriable;
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
