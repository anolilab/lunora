import type { OfflineQueueOptions } from "./types.js";

export interface QueuedMutation<T = unknown> {
    readonly args: Record<string, unknown>;
    readonly functionPath: string;
    /** Rejects if the mutation can no longer be replayed. */
    readonly reject: (error: unknown) => void;
    /** Resolves once the mutation has been replayed against the server. */
    readonly resolve: (value: T) => void;
    readonly shardKey?: string;
}

/**
 * Bounded FIFO queue. Mutations issued while the client is offline are
 * enqueued and replayed in the order they were submitted once the WS
 * reconnects and identifies. If the queue exceeds `maxItems` the oldest
 * entry is rejected with `OFFLINE_QUEUE_OVERFLOW`.
 */
export class OfflineQueue {
    private readonly maxItems: number;

    private readonly items: QueuedMutation[] = [];

    public constructor(options: OfflineQueueOptions = {}) {
        this.maxItems = options.maxItems ?? 1000;
    }

    public get size(): number {
        return this.items.length;
    }

    public enqueue<T>(entry: QueuedMutation<T>): void {
        this.items.push(entry as QueuedMutation);

        while (this.items.length > this.maxItems) {
            const dropped = this.items.shift();

            if (dropped) {
                const error = new Error("offline queue overflow");

                (error as Error & { code?: string }).code = "OFFLINE_QUEUE_OVERFLOW";
                dropped.reject(error);
            }
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
        // forever when the client is closed mid-flight.
        for (const item of this.items) {
            const error = new Error("CLIENT_CLOSED");

            (error as Error & { code?: string }).code = "CLIENT_CLOSED";
            item.reject(error);
        }

        this.items.length = 0;
    }
}
