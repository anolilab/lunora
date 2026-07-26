import { randomId } from "../../../shared/uuid";
import isStaleVersion from "./persisted-version";
import type { OfflineQueueOptions, PersistedMutation, PersistenceAdapter, PersistenceErrorContext, PersistenceOperation } from "./types";

interface QueuedMutation<T = unknown> {
    readonly args: Record<string, unknown>;
    readonly functionPath: string;

    /** Stable id used to remove the entry from durable storage once replayed; assigned by the queue when absent. */
    id?: string;

    /**
     * Issuing identity fingerprint carried through to durable storage (`null` =
     * signed out). Absent on hydrated legacy records, which replay ambiently.
     */
    readonly identity?: string | null;

    /**
     * `true` when a live caller is still awaiting this write's `mutation()`
     * Promise; `false`/absent for a write restored from durable storage after a
     * reload (its original awaiter is gone). Carried so terminal-verdict
     * observers can distinguish "the caller already saw this" from "nothing else
     * will report this". Maps to the public `MutationSettledEvent.hadAwaiter`.
     */
    liveAwaiter?: boolean;

    /**
     * Invoked on a successful replay with the server's echoed commit CDC cursor,
     * so a live per-call optimistic layer drops gaplessly once a frame reaches it.
     * Absent on hydrated records (the optimistic write lived in a prior session).
     */
    readonly onCommit?: (commitCursor: number | undefined) => void;

    /**
     * Optional sync predicate evaluated just before replay. When it returns
     * `false` the write is dropped instead of replaying, handling the case
     * where the mutation's preconditions are no longer valid (e.g. the
     * document it referred to was deleted while offline). Absent or `true`
     * means "ok to replay".
     */
    readonly precondition?: () => boolean;
    /** Rejects if the mutation can no longer be replayed. */
    readonly reject: (error: unknown) => void;
    /** Resolves once the mutation has been replayed against the server. */
    readonly resolve: (value: T) => void;
    readonly shardKey?: string;
}

/**
 * Invoked when the queue itself discards an entry on overflow (capacity
 * eviction), so the client can surface the dropped write on its
 * terminal-verdict observer even when the entry has no live awaiter (a hydrated
 * record). The `error` carries the `OFFLINE_QUEUE_OVERFLOW` code.
 */
type EvictHandler = (entry: QueuedMutation, error: Error & { code?: string }) => void;

/** Injected dependencies for {@link OfflineQueue} (kept off the user-facing {@link OfflineQueueOptions}). */
interface OfflineQueueDeps {
    /** Invoked when an entry is discarded on capacity overflow (carries `OFFLINE_QUEUE_OVERFLOW`). */
    onEvict?: EvictHandler;
    /** Invoked with the new depth after any size change (drives the client's pending-sync count). */
    onSizeChange?: (size: number) => void;
    /** Durable store; when present, writes are mirrored and restored across reloads. */
    persistence?: PersistenceAdapter;
    /** App/schema version stamped on persisted writes; mismatched records are purged on hydrate. */
    version?: string;
}

/**
 * A process-unique id, used both per-mutation and as the fallback `clientId`. It
 * MUST be globally unique: the server scopes a custom mutator's replay watermark
 * by `(verifiedIdentity, clientId)`, and an anonymous push has no verified
 * identity — so two anonymous clients that collide on `clientId` would share one
 * watermark namespace, letting one stall/suppress the other's ordered mutations.
 *
 * The generator lives in `shared/uuid.ts` (a bundler-inlined, zero-dep helper)
 * so this file and `@lunora/replica`'s diff-id minting share ONE guarded
 * implementation instead of drifting copies. `randomId` prefers
 * `crypto.randomUUID`; its fallback mixes crypto-quality (or `Math.random`)
 * entropy with a timestamp + counter so it can't collide across two clients
 * started in the same millisecond. Re-exported under the historical `nextId`
 * name for existing importers.
 */
const nextId: () => string = randomId;

/**
 * Report a swallowed persistence rejection: hand it to the caller's handler if
 * one is configured, else `console.warn` so it is never fully silent.
 */
const reportPersistenceError = (
    handler: ((context: PersistenceErrorContext) => void) | undefined,
    operation: PersistenceOperation,
    error: unknown,
    mutationId?: string,
): void => {
    if (handler) {
        handler({ error, mutationId, operation });
        return;
    }

    // eslint-disable-next-line no-console -- last-resort visibility for a swallowed durable-write failure
    console.warn(`[lunora] offline-queue persistence ${operation} failed`, error);
};

/**
 * Bounded FIFO queue. Mutations issued while the client is offline are
 * enqueued and replayed in the order they were submitted once the WS
 * reconnects and identifies. If the queue exceeds `maxItems` the oldest
 * entry is rejected with `OFFLINE_QUEUE_OVERFLOW`.
 *
 * When a {@link PersistenceAdapter} is supplied, enqueued mutations are mirrored
 * to durable storage so they survive a reload — {@link OfflineQueue.hydrate} restores them on
 * the next startup and the client replays them on reconnect. Durable removal is
 * the caller's responsibility *after* a successful replay (see `LunoraClient`);
 * the queue only persists on enqueue and un-persists on overflow.
 */
class OfflineQueue {
    /** Opt-in to queueing mutations before the targeted shard's first connect. */
    public readonly queueBeforeFirstConnect: boolean;

    private readonly maxItems: number;

    private readonly onPersistenceError: ((context: PersistenceErrorContext) => void) | undefined;

    private readonly persistence: PersistenceAdapter | undefined;

    private readonly onEvict: EvictHandler | undefined;

    private readonly onSizeChange: ((size: number) => void) | undefined;

    /** App/schema version stamped on persisted writes; mismatched records are purged on hydrate. */
    private readonly version: string | undefined;

    private readonly items: QueuedMutation[] = [];

    public constructor(options: OfflineQueueOptions = {}, deps: OfflineQueueDeps = {}) {
        this.maxItems = options.maxItems ?? 1000;
        this.queueBeforeFirstConnect = options.queueBeforeFirstConnect ?? false;
        this.onPersistenceError = options.onPersistenceError;
        this.persistence = deps.persistence;
        this.onEvict = deps.onEvict;
        this.onSizeChange = deps.onSizeChange;
        this.version = deps.version;
    }

    public get size(): number {
        return this.items.length;
    }

    public enqueue<T>(entry: QueuedMutation<T>): void {
        const item = entry as QueuedMutation;

        item.id ??= nextId();
        this.items.push(item);

        this.persistence
            ?.append({
                args: item.args,
                functionPath: item.functionPath,
                id: item.id,
                identity: item.identity,
                shardKey: item.shardKey,
                ...(this.version === undefined ? {} : { version: this.version }),
            })
            .catch((error: unknown) => {
                reportPersistenceError(this.onPersistenceError, "append", error, item.id);
            });

        while (this.items.length > this.maxItems) {
            const dropped = this.items.shift();

            if (dropped) {
                if (dropped.id) {
                    this.persistence?.remove(dropped.id).catch((error: unknown) => {
                        reportPersistenceError(this.onPersistenceError, "remove", error, dropped.id);
                    });
                }

                const error = new Error("offline queue overflow");

                (error as Error & { code?: string }).code = "OFFLINE_QUEUE_OVERFLOW";
                dropped.reject(error);
                // Also surface on the client's terminal-verdict observer: a
                // hydrated entry's `reject` is a no-op, so without this an
                // overflow eviction would silently drop a durable write.
                this.onEvict?.(dropped, error);
            }
        }

        this.notifySize();
    }

    /**
     * Restore mutations persisted in a prior session and re-queue them in FIFO
     * order. Restored entries already live in durable storage, so they are not
     * re-appended; they carry no-op `resolve`/`reject` (the original awaiter is
     * gone after a reload). No-op when no persistence adapter is configured.
     * Returns the distinct shard keys of the restored writes so the caller can
     * open their sockets to trigger a flush.
     *
     * `hydrate()` runs post-construction (the caller awaits an async durable-store
     * load), so a mutation issued while offline during that boot window is
     * enqueued into `items` *before* this method's `await` resolves. Restored
     * records are therefore `unshift`-ed ahead of whatever is already queued
     * rather than `push`-ed to the end: the durable store's persist order is
     * authoritative (a prior-session write is always older than anything from
     * this session), so replaying a same-session boot-time write before an
     * older restored write on the same document would let last-writer-wins
     * silently clobber the newer data with the stale one.
     */
    public async hydrate(): Promise<(string | undefined)[]> {
        if (!this.persistence) {
            return [];
        }

        let persisted: PersistedMutation[];

        try {
            persisted = await this.persistence.load();
        } catch (error) {
            reportPersistenceError(this.onPersistenceError, "load", error);
            throw error;
        }

        const shardKeys = new Set<string | undefined>();
        const restored: QueuedMutation[] = [];

        for (const mutation of persisted) {
            if (this.items.some((item) => item.id === mutation.id) || restored.some((item) => item.id === mutation.id)) {
                continue;
            }

            // Version gate: a write persisted by a different app/schema version is
            // dropped and purged rather than replayed against the current schema.
            if (isStaleVersion(this.version, mutation.version)) {
                this.persistence.remove(mutation.id).catch((error: unknown) => {
                    reportPersistenceError(this.onPersistenceError, "remove", error, mutation.id);
                });

                continue;
            }

            restored.push({
                args: mutation.args,
                functionPath: mutation.functionPath,
                id: mutation.id,
                identity: mutation.identity,
                reject: () => undefined,
                resolve: () => undefined,
                shardKey: mutation.shardKey,
            });
            shardKeys.add(mutation.shardKey);
        }

        this.items.unshift(...restored);

        this.notifySize();

        return [...shardKeys];
    }

    /**
     * Remove and return queued mutations. With no `predicate`, drains the whole
     * queue. With one, drains only matching entries (preserving FIFO order) and
     * leaves the rest queued — used to flush a single shard's writes when its
     * socket reconnects while other shards are still down.
     */
    public drain(predicate?: (item: QueuedMutation) => boolean): QueuedMutation[] {
        if (!predicate) {
            const drained = [...this.items];

            this.items.length = 0;
            this.notifySize();

            return drained;
        }

        const drained: QueuedMutation[] = [];
        const kept: QueuedMutation[] = [];

        for (const item of this.items) {
            (predicate(item) ? drained : kept).push(item);
        }

        this.items.length = 0;
        this.items.push(...kept);
        this.notifySize();

        return drained;
    }

    /**
     * Return previously-drained mutations to the front of the queue, preserving
     * their FIFO order, without re-persisting them — they were never unpersisted,
     * so durable storage still holds them. Used when a flush aborts on a transient
     * transport failure: the unreplayed writes stay queued for the next reconnect.
     */
    public requeue(items: QueuedMutation[]): void {
        if (items.length === 0) {
            return;
        }

        this.items.unshift(...items);
        this.notifySize();
    }

    /**
     * Remove mutations whose precondition evaluates to `false` (stale/dirty
     * writes that should not replay) and reject each with an
     * `OFFLINE_PRECONDITION_FAILED` error. The valid (admitted) mutations stay
     * queued in FIFO order. Returns the drained stale entries.
     *
     * Called during reconnect before the flush cycle to weed out writes whose
     * assumptions no longer hold (e.g. a document was deleted by another client).
     */
    public drainConflict(): QueuedMutation[] {
        const conflicted: QueuedMutation[] = [];
        const kept: QueuedMutation[] = [];

        for (const item of this.items) {
            if (item.precondition !== undefined && !item.precondition()) {
                const error = new Error("offline mutation skipped: precondition failed before replay");

                (error as Error & { code?: string }).code = "OFFLINE_PRECONDITION_FAILED";
                item.reject(error);
                conflicted.push(item);
            } else {
                kept.push(item);
            }
        }

        if (conflicted.length > 0) {
            this.items.length = 0;
            this.items.push(...kept);
            this.notifySize();
        }

        return conflicted;
    }

    public clear(): void {
        // Reject every pending mutation so awaiting callers don't hang
        // forever when the client is closed mid-flight. Durable storage is left
        // intact on purpose — closing a tab must not discard writes a future
        // session will restore via `hydrate`; use the adapter's `clear()` to
        // purge them (e.g. on logout).
        for (const item of this.items) {
            const error = new Error("CLIENT_CLOSED");

            (error as Error & { code?: string }).code = "CLIENT_CLOSED";
            item.reject(error);
        }

        this.items.length = 0;
        this.notifySize();
    }

    /** Notify the size observer (the client's pending-sync count) after any change. */
    private notifySize(): void {
        this.onSizeChange?.(this.items.length);
    }
}

export { nextId, OfflineQueue, reportPersistenceError };
export type { QueuedMutation };
