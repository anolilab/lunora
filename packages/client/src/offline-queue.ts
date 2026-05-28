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

    public drain(): QueuedMutation[] {
        const drained = [...this.items];

        this.items.length = 0;

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
