/**
 * Backoff for a live query that keeps throwing when a write flush re-runs it.
 *
 * Without it a subscription whose handler fails deterministically is re-run on
 * every flush for every socket that holds it, for the life of the socket, and
 * tells the client nothing after the first failure.
 *
 * The first failure retries on the very next flush, because one failure is as
 * likely to be transient as deterministic. From the second consecutive failure
 * on, the subscription is skipped until a doubling delay (capped) has elapsed.
 * A different caller identity ends the wait: a handler that denied one token
 * may accept the next.
 */

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

interface SubscriptionFailure {
    failures: number;
    identity: string;
    retryAt: number;
}

/** Delay before the retry that follows the `failures`-th consecutive failure. */
const backoffDelay = (failures: number): number => (failures <= 1 ? 0 : Math.min(BACKOFF_BASE_MS * 2 ** (failures - 2), BACKOFF_MAX_MS));

class SubscriptionFailureLatch {
    private readonly bySocket = new WeakMap<object, Map<string, SubscriptionFailure>>();

    /** Whether `socket` has any subscription in a failure streak, so callers can skip deriving an identity key. */
    public hasFailures(socket: object): boolean {
        return (this.bySocket.get(socket)?.size ?? 0) > 0;
    }

    /** Whether the subscription is inside its backoff window for this identity and must not be re-run. */
    public isBackingOff(socket: object, subId: string, identity: string, now: number): boolean {
        const entry = this.bySocket.get(socket)?.get(subId);

        return entry?.identity === identity && now < entry.retryAt;
    }

    /**
     * Record a failed run.
     * @returns true when this starts a new streak (the first failure, or the first under a new identity), i.e. when the client should be told
     */
    public recordFailure(socket: object, subId: string, identity: string, now: number): boolean {
        let entries = this.bySocket.get(socket);

        if (entries === undefined) {
            entries = new Map();
            this.bySocket.set(socket, entries);
        }

        const previous = entries.get(subId);
        const continuing = previous?.identity === identity;
        const failures = continuing ? previous.failures + 1 : 1;

        entries.set(subId, { failures, identity, retryAt: now + backoffDelay(failures) });

        return !continuing;
    }

    /** The subscription ran cleanly, or was replaced or removed. */
    public clear(socket: object, subId: string): void {
        this.bySocket.get(socket)?.delete(subId);
    }

    public clearSocket(socket: object): void {
        this.bySocket.delete(socket);
    }
}

export default SubscriptionFailureLatch;
