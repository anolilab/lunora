import { randomId } from "../../../shared/uuid";
import isStaleVersion from "./persisted-version";
import type { OfflineQueueOptions, PersistedMutation, PersistenceAdapter, PersistenceErrorContext, PersistenceOperation } from "./types";

interface QueuedMutation<T = unknown> {
    readonly args: Record<string, unknown>;

    /**
     * The client id that queued this write (see {@link PersistedMutation.clientId}).
     * Persisted and restored, so a replay namespaces by the id that issued the
     * write rather than whatever the current session minted.
     */
    clientId?: string;
    readonly functionPath: string;

    /** Stable id used to remove the entry from durable storage once replayed; assigned by the queue when absent. */
    id?: string;

    /**
     * Issuing identity fingerprint carried through to durable storage (`null` =
     * signed out). Absent on hydrated legacy records, which replay ambiently.
     *
     * Mutable so {@link OfflineQueue.restampIdentity} can relabel a still-queued
     * write when the identity's LABEL changes but the credential does not (the
     * `setAuthToken(token, userId)` case where the subject resolves a tick after
     * the token). The value is re-persisted alongside, so the new label survives
     * a reload and a requeue.
     */
    identity?: string | null;

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
 *
 * The `sdks/*` ports deliberately do NOT mirror this shape — they return the
 * discarded entry from `enqueue`/`hydrate`/`drainConflict`/`clear` instead,
 * because they call the queue with a real lock held and settling a write needs
 * that same lock, which self-deadlocks a non-reentrant one. Keep the callback
 * here: this client is single-threaded, so the hazard does not exist, and an
 * observer the queue fires itself is what covers the case a return value's
 * consumer can quietly miss — a hydrated entry whose `reject` is a no-op.
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
 *
 * The handler is app-supplied, so it can throw — and every call site here is
 * either a `.catch()` on a floating promise (where a rethrow becomes an
 * unhandled rejection) or a compensating cleanup path whose remaining steps
 * would be skipped (see {@link OfflineQueue.rewriteStamp}, where skipping them
 * loses the mutation outright). A reporting call must therefore never be able
 * to change control flow: a throwing handler is contained here and falls back
 * to the same `console.warn` as no handler at all, so the failure it was meant
 * to report is still visible.
 */
const reportPersistenceError = (
    handler: ((context: PersistenceErrorContext) => void) | undefined,
    operation: PersistenceOperation,
    error: unknown,
    mutationId?: string,
): void => {
    if (handler) {
        try {
            handler({ error, mutationId, operation });

            return;
        } catch {
            /* fall through to the console warning below */
        }
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
                clientId: item.clientId,
                functionPath: item.functionPath,
                id: item.id,
                identity: item.identity,
                shardKey: item.shardKey,
                ...(this.version === undefined ? {} : { version: this.version }),
            })
            .catch((error: unknown) => {
                reportPersistenceError(this.onPersistenceError, "append", error, item.id);
            });

        this.evictOverflow();

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

        const restored: QueuedMutation[] = [];
        // Ids already queued or already restored — a Set keeps the dedupe O(n)
        // over durable stores that legitimately exceed `maxItems`.
        const seen = new Set(this.items.map((item) => item.id));

        for (const mutation of persisted) {
            if (seen.has(mutation.id)) {
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

            // Added only on push — a version-gated record was never in
            // `restored`, so a later duplicate of it must not be deduped.
            seen.add(mutation.id);
            restored.push({
                args: mutation.args,
                clientId: mutation.clientId,
                functionPath: mutation.functionPath,
                id: mutation.id,
                identity: mutation.identity,
                reject: () => undefined,
                resolve: () => undefined,
                shardKey: mutation.shardKey,
            });
        }

        this.items.unshift(...restored);

        // A durable store holding more than `maxItems` records (e.g. `maxItems`
        // was lowered between sessions, or writes piled up while the app was
        // fully offline across restarts) must not bypass the cap — evict from
        // the front (the oldest restored entries) exactly as `enqueue` does, so
        // the in-memory queue never exceeds `maxItems` regardless of how it got
        // there (CLIENT-03).
        this.evictOverflow();

        this.notifySize();

        // Compute shard keys AFTER eviction, from whichever restored entries
        // actually survived: `evictOverflow` drops from the front of `items`
        // (the oldest restored entries first), so a shard key gathered before
        // eviction can point at a mutation that no longer exists — the caller
        // would then call `ensureSocket()` for a shard with nothing queued.
        const survivingItems = new Set(this.items);
        const shardKeys = new Set<string | undefined>();

        for (const mutation of restored) {
            if (survivingItems.has(mutation)) {
                shardKeys.add(mutation.shardKey);
            }
        }

        return [...shardKeys];
    }

    /**
     * Relabel every queued write stamped `from` to `to`, in memory AND in durable
     * storage.
     *
     * Used when the auth identity's LABEL changes while the credential does not —
     * `setAuthToken(token, userId)` where the user id resolves a tick after the
     * token was set. `setAuthToken` documents that this re-stamps in-flight
     * queued writes rather than dropping them, and that promise only held for the
     * caller's live in-memory stamp map, which is consumed and deleted on the
     * first flush attempt. Everything durable still carried the old token hash,
     * so a reload — or a transient-failure requeue after the token had since been
     * refreshed — fell back to it, failed the replay identity gate, and rejected
     * the SAME user's offline write with `OFFLINE_IDENTITY_CHANGED`.
     *
     * The durable rewrite goes through `PersistenceAdapter.replace`, the one
     * operation on the contract that is required to be atomic — see
     * {@link OfflineQueue.rewriteStamp}.
     */
    public restampIdentity(from: string | null, to: string | null): void {
        for (const item of this.items) {
            if (item.identity !== from) {
                continue;
            }

            item.identity = to;

            const { id } = item;

            if (!this.persistence || id === undefined) {
                continue;
            }

            const record: PersistedMutation = {
                args: item.args,
                clientId: item.clientId,
                functionPath: item.functionPath,
                id,
                identity: to,
                shardKey: item.shardKey,
                ...(this.version === undefined ? {} : { version: this.version }),
            };

            this.rewriteStamp(id, record).catch((error: unknown) => {
                // `rewriteStamp` reports and contains every failure of the durable
                // write itself; what reaches here is a failure of the REPORTING (an
                // `onPersistenceError` handler that throws and a `console.warn` that
                // throws after it), plus whatever future edit adds a throw outside
                // that try. Either way it keeps the fire-and-forget call from
                // floating — and the operation named is still `replace`, the one
                // this method performs: an app that routes on `context.operation`
                // must not be told a write it never issued has failed.
                reportPersistenceError(this.onPersistenceError, "replace", error, id);
            });
        }
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

    /**
     * The durable half of {@link OfflineQueue.restampIdentity}: rewrite the
     * persisted record under the new identity stamp.
     *
     * This used to be `remove` then `append` (because `append` is an insert, not
     * an upsert) with a compensating re-append on failure, and no arrangement of
     * those two calls is safe. A process stop between a committed `remove` and
     * the `append` leaves the mutation in NO durable store while the in-memory
     * entry has already advanced, so a reload loses the write outright — and
     * compensation cannot cover a crash, only a rejection. The re-append also
     * moved the record to the tail, replaying it out of issue order.
     *
     * `PersistenceAdapter.replace` is the single atomic operation that removes
     * both: the swap lands whole or not at all, and the record keeps its place
     * in FIFO order. A rejection means nothing changed durably — the record
     * stands under its OLD stamp, which is the documented outcome (a replay
     * under a stale stamp is refused with `OFFLINE_IDENTITY_CHANGED`, visible
     * and recoverable, unlike a silent loss) — so there is nothing to
     * compensate, only to report.
     */
    private async rewriteStamp(id: string, record: PersistedMutation): Promise<void> {
        const store = this.persistence;

        if (!store) {
            return;
        }

        try {
            await store.replace(record);
        } catch (error: unknown) {
            reportPersistenceError(this.onPersistenceError, "replace", error, id);
        }
    }

    /**
     * Evict entries from the FRONT of `items` (the oldest — FIFO order) until
     * the queue is at or under `maxItems`, rejecting each with
     * `OFFLINE_QUEUE_OVERFLOW`, un-persisting it, and firing `onEvict`. Shared
     * by `enqueue` (a live write pushes past capacity) and `hydrate` (a durable
     * store restored more than `maxItems` records — CLIENT-03) so an overflow
     * always drops the same way regardless of which caller triggered it.
     */
    private evictOverflow(): void {
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
    }

    /** Notify the size observer (the client's pending-sync count) after any change. */
    private notifySize(): void {
        this.onSizeChange?.(this.items.length);
    }
}

export { nextId, OfflineQueue, reportPersistenceError };
export type { QueuedMutation };
