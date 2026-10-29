import type { TransactionHeadroom } from "@lunora/shard-engine";
import { TransactionHeadroomTracker } from "@lunora/shard-engine";

/**
 * A resource meter with a stable identity whose budget resets per dispatch.
 *
 * Production builds a fresh `createShardCtxDb` writer — and with it a fresh
 * {@link TransactionHeadroomTracker} — for every dispatch. The in-process
 * runtime builds one writer per identity view, so it hands that writer this
 * forwarder and swaps the tracker behind it at each top-level entry: every
 * dispatch gets its own budget, and the ceilings are the engine defaults rather
 * than "unmetered".
 */
class DispatchHeadroom extends TransactionHeadroomTracker {
    private current = new TransactionHeadroomTracker();

    /** Begin a new dispatch with a full budget. */
    public reset(): void {
        this.current = new TransactionHeadroomTracker();
    }

    public override headroom(): TransactionHeadroom {
        return this.current.headroom();
    }

    public override recordRead(count: number): void {
        this.current.recordRead(count);
    }

    public override recordReadBytes(bytes: number): void {
        this.current.recordReadBytes(bytes);
    }

    public override recordDocumentRead(key: string, bytes: number): void {
        this.current.recordDocumentRead(key, bytes);
    }

    public override recordWrite(row: unknown): void {
        this.current.recordWrite(row);
    }
}

export default DispatchHeadroom;
