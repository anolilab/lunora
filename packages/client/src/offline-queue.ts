import type { OfflineQueueOptions, PersistenceAdapter } from "./types";

interface QueuedMutation<T = unknown> {
    readonly args: Record<string, unknown>;
    readonly functionPath: string;
    /** Stable id used to remove the entry from durable storage once replayed; assigned by the queue when absent. */
    id?: string;
    /** Rejects if the mutation can no longer be replayed. */
    readonly reject: (error: unknown) => void;
    /** Resolves once the mutation has been replayed against the server. */
    readonly resolve: (value: T) => void;
    readonly shardKey?: string;
}

let idCounter = 0;

const nextId = (): string => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    idCounter += 1;

    return `m_${Date.now().toString(36)}_${idCounter.toString(36)}`;
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
 * the caller's responsibility *after* a successful replay (see `CirrusClient`);
 * the queue only persists on enqueue and un-persists on overflow.
 */
class OfflineQueue {
    /** Opt-in to queueing mutations before the targeted shard's first connect. */
    public readonly queueBeforeFirstConnect: boolean;

    private readonly maxItems: number;

    private readonly persistence: PersistenceAdapter | undefined;

    private readonly items: QueuedMutation[] = [];

    public constructor(options: OfflineQueueOptions = {}, persistence?: PersistenceAdapter) {
        this.maxItems = options.maxItems ?? 1000;
        this.queueBeforeFirstConnect = options.queueBeforeFirstConnect ?? false;
        this.persistence = persistence;
    }

    public get size(): number {
        return this.items.length;
    }

    public enqueue<T>(entry: QueuedMutation<T>): void {
        const item = entry as QueuedMutation;

        item.id ??= nextId();
        this.items.push(item);

        this.persistence?.append({ args: item.args, functionPath: item.functionPath, id: item.id, shardKey: item.shardKey }).catch(() => undefined);

        while (this.items.length > this.maxItems) {
            const dropped = this.items.shift();

            if (dropped) {
                if (dropped.id) {
                    this.persistence?.remove(dropped.id).catch(() => undefined);
                }

                const error = new Error("offline queue overflow");

                (error as Error & { code?: string }).code = "OFFLINE_QUEUE_OVERFLOW";
                dropped.reject(error);
            }
        }
    }

    /**
     * Restore mutations persisted in a prior session and re-queue them in FIFO
     * order. Restored entries already live in durable storage, so they are not
     * re-appended; they carry no-op `resolve`/`reject` (the original awaiter is
     * gone after a reload). No-op when no persistence adapter is configured.
     * Returns the distinct shard keys of the restored writes so the caller can
     * open their sockets to trigger a flush.
     */
    public async hydrate(): Promise<(string | undefined)[]> {
        if (!this.persistence) {
            return [];
        }

        const persisted = await this.persistence.load();
        const shardKeys = new Set<string | undefined>();

        for (const mutation of persisted) {
            if (this.items.some((item) => item.id === mutation.id)) {
                continue;
            }

            this.items.push({
                args: mutation.args,
                functionPath: mutation.functionPath,
                id: mutation.id,
                reject: () => undefined,
                resolve: () => undefined,
                shardKey: mutation.shardKey,
            });
            shardKeys.add(mutation.shardKey);
        }

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

            return drained;
        }

        const drained: QueuedMutation[] = [];
        const kept: QueuedMutation[] = [];

        for (const item of this.items) {
            (predicate(item) ? drained : kept).push(item);
        }

        this.items.length = 0;
        this.items.push(...kept);

        return drained;
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
    }
}

export { OfflineQueue };
export type { QueuedMutation };
