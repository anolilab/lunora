/**
 * The durable sync store seam.
 *
 * `PaymentStore` is the single interface the engine writes through. The in-memory implementation
 * here backs tests and local dev; a Durable-Object-backed implementation (SQLite + OCC) drops in
 * behind the same interface for production without touching call sites.
 */
import type { Customer, PaymentSession, ProviderId, Subscription, UsageEvent } from "./types";

const customerKey = (provider: ProviderId, referenceId: string): string => `${provider}:${referenceId}`;

const recordKey = (provider: ProviderId, id: string): string => `${provider}:${id}`;

/**
 * `PaymentStore` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface PaymentStore {
    getCustomerByReference: (provider: ProviderId, referenceId: string) => Promise<Customer | undefined>;
    getPaymentSession: (provider: ProviderId, id: string) => Promise<PaymentSession | undefined>;
    getSubscription: (provider: ProviderId, id: string) => Promise<Subscription | undefined>;
    listSubscriptionsByReference: (referenceId: string) => Promise<Subscription[]>;

    /**
     * Usage events that still owe an upstream forward, oldest first, at most `limit`.
     *
     * "Owes a forward" is narrower than `reportedToProvider === false`: only an
     * ADDITIVE event with a positive `quantity` qualifies. A `"set"` event's
     * upstream delta was measured against the period total at the moment it was
     * recorded and is not recoverable afterwards, and a non-positive quantity was
     * never sent, so neither is a retry candidate — returning them would make the
     * sweep re-send the same rows forever (or double-count on an additive meter).
     *
     * Read by `reconcile` to retry a forward the provider rejected transiently;
     * without it a single 5xx loses that metered unit upstream for good, which for
     * a provider that owns entitlements under-bills and over-entitles the customer.
     */
    listUnreportedUsage: (provider: ProviderId, limit: number) => Promise<UsageEvent[]>;

    /**
     * Claims a provider event id for processing. Resolves `true` the first time an event is seen
     * and `false` for a duplicate — the inbound-idempotency primitive.
     *
     * `type` is recorded on the claim row so the `events` table is a readable audit log rather than
     * bare ids and timestamps: a real delivery passes its `WebhookActionType`, and the
     * internal claim markers (`sync.ts`'s orphan-retry bound, the local-refund ledger) pass a
     * `marker.*` label so they are distinguishable from provider traffic in the studio.
     */
    markEventProcessed: (provider: ProviderId, eventId: string, type: string) => Promise<boolean>;
    /** Flag a recorded usage event as forwarded to the provider's metering API. */
    markUsageReported: (provider: ProviderId, idempotencyKey: string) => Promise<void>;

    /**
     * Append a usage event. Resolves `true` when newly recorded and `false` when its
     * `idempotencyKey` was already seen — the exactly-once primitive behind `track`.
     */
    recordUsage: (event: UsageEvent) => Promise<boolean>;

    /**
     * Release a previously-claimed event id (see {@link PaymentStore.markEventProcessed}) so a
     * provider retry can re-process it. Called only when applying the claimed event *throws* (a
     * genuine store-write failure): the atomic insert-claim guards concurrent duplicates, but a
     * claim that outlives a failed apply would dedupe the retry and lose the effect — so the claim
     * is rolled back on failure. A no-op if the id was never claimed.
     */
    releaseEvent: (provider: ProviderId, eventId: string) => Promise<void>;

    /**
     * The period total for a `(referenceId, featureId)` pair since `since` (epoch ms).
     *
     * NOT a plain sum: events are folded in `createdAt` order (ties broken by
     * `idempotencyKey`, so every store agrees on the same order for events stamped
     * in the same millisecond). An `"add"` event increments the running total; a
     * `"set"` event RESETS it to that event's `quantity`, discarding everything
     * earlier in the period. Use {@link foldUsage} so the two implementations
     * cannot drift.
     *
     * This fold is what lets `track({ mode: "set" })` be append-only. Reconciling by
     * writing `target - current` instead would be a read-modify-write across two
     * un-transacted store calls: two interleaved `set`s would both read the same
     * total, both append a delta, and leave the period over- or under-counted —
     * inflating `balance = limit - used`. Here a concurrent pair simply resolves
     * last-writer-wins, and a replayed `set` is idempotent by construction.
     */
    sumUsage: (referenceId: string, featureId: string, since: number) => Promise<number>;

    /** Period usage totals for many features in one read — the batch form of {@link PaymentStore.sumUsage}. */
    sumUsageByFeature: (referenceId: string, featureIds: ReadonlyArray<string>, since: number) => Promise<ReadonlyMap<string, number>>;
    upsertCustomer: (customer: Customer) => Promise<void>;
    upsertPaymentSession: (session: PaymentSession) => Promise<void>;
    upsertSubscription: (subscription: Subscription) => Promise<void>;
}

/**
 * Fold usage events into a period total: `"add"` increments, `"set"` resets to its
 * own `quantity` and discards everything before it.
 *
 * Sorting is part of the contract, not an optimisation — `createdAt` first, then
 * `idempotencyKey` as a deterministic tiebreak so two events stamped in the same
 * millisecond fold identically in every store and on every replay. Callers pass
 * only the events already filtered to the `(referenceId, featureId, >= since)`
 * window.
 *
 * Exported so {@link MemoryPaymentStore} and the database-backed store share ONE
 * definition: a divergence between them would show up as a metered limit that
 * enforces differently in tests than in production.
 * @experimental
 */
export const foldUsage = (events: ReadonlyArray<Pick<UsageEvent, "createdAt" | "idempotencyKey" | "mode" | "quantity">>): number => {
    const ordered = events.toSorted((a, b) => a.createdAt - b.createdAt || a.idempotencyKey.localeCompare(b.idempotencyKey));
    let total = 0;

    for (const event of ordered) {
        total = event.mode === "set" ? event.quantity : total + event.quantity;
    }

    return total;
};

/**
 * In-memory {@link PaymentStore} for tests and local development. Not durable.
 * @experimental
 */
export class MemoryPaymentStore implements PaymentStore {
    private readonly customers = new Map<string, Customer>();

    private readonly processedEvents = new Set<string>();

    private readonly sessions = new Map<string, PaymentSession>();

    private readonly subscriptions = new Map<string, Subscription>();

    private readonly usageEvents = new Map<string, UsageEvent>();

    public getCustomerByReference(provider: ProviderId, referenceId: string): Promise<Customer | undefined> {
        return Promise.resolve(this.customers.get(customerKey(provider, referenceId)));
    }

    public getPaymentSession(provider: ProviderId, id: string): Promise<PaymentSession | undefined> {
        return Promise.resolve(this.sessions.get(recordKey(provider, id)));
    }

    public getSubscription(provider: ProviderId, id: string): Promise<Subscription | undefined> {
        return Promise.resolve(this.subscriptions.get(recordKey(provider, id)));
    }

    public listSubscriptionsByReference(referenceId: string): Promise<Subscription[]> {
        return Promise.resolve([...this.subscriptions.values()].filter((subscription) => subscription.referenceId === referenceId));
    }

    public listUnreportedUsage(provider: ProviderId, limit: number): Promise<UsageEvent[]> {
        const pending = [...this.usageEvents.values()]
            .filter((event) => event.provider === provider && !event.reportedToProvider && event.mode !== "set" && event.quantity > 0)
            .toSorted((a, b) => a.createdAt - b.createdAt || a.idempotencyKey.localeCompare(b.idempotencyKey));

        return Promise.resolve(pending.slice(0, Math.max(0, limit)));
    }

    public markEventProcessed(provider: ProviderId, eventId: string, _type: string): Promise<boolean> {
        const key = recordKey(provider, eventId);

        if (this.processedEvents.has(key)) {
            return Promise.resolve(false);
        }

        this.processedEvents.add(key);

        return Promise.resolve(true);
    }

    public releaseEvent(provider: ProviderId, eventId: string): Promise<void> {
        this.processedEvents.delete(recordKey(provider, eventId));

        return Promise.resolve();
    }

    public markUsageReported(provider: ProviderId, idempotencyKey: string): Promise<void> {
        const key = recordKey(provider, idempotencyKey);
        const existing = this.usageEvents.get(key);

        if (existing) {
            this.usageEvents.set(key, { ...existing, reportedToProvider: true });
        }

        return Promise.resolve();
    }

    public recordUsage(event: UsageEvent): Promise<boolean> {
        const key = recordKey(event.provider, event.idempotencyKey);

        if (this.usageEvents.has(key)) {
            return Promise.resolve(false);
        }

        this.usageEvents.set(key, event);

        return Promise.resolve(true);
    }

    public sumUsage(referenceId: string, featureId: string, since: number): Promise<number> {
        const window: UsageEvent[] = [];

        for (const event of this.usageEvents.values()) {
            if (event.referenceId === referenceId && event.featureId === featureId && event.createdAt >= since) {
                window.push(event);
            }
        }

        return Promise.resolve(foldUsage(window));
    }

    public sumUsageByFeature(referenceId: string, featureIds: ReadonlyArray<string>, since: number): Promise<ReadonlyMap<string, number>> {
        const buckets = new Map<string, UsageEvent[]>(featureIds.map((featureId) => [featureId, []]));

        for (const event of this.usageEvents.values()) {
            if (event.referenceId === referenceId && event.createdAt >= since) {
                buckets.get(event.featureId)?.push(event);
            }
        }

        return Promise.resolve(new Map([...buckets].map(([featureId, window]) => [featureId, foldUsage(window)])));
    }

    public upsertCustomer(customer: Customer): Promise<void> {
        this.customers.set(customerKey(customer.provider, customer.referenceId), customer);

        return Promise.resolve();
    }

    public upsertPaymentSession(session: PaymentSession): Promise<void> {
        this.sessions.set(recordKey(session.provider, session.id), session);

        return Promise.resolve();
    }

    public upsertSubscription(subscription: Subscription): Promise<void> {
        this.subscriptions.set(recordKey(subscription.provider, subscription.id), subscription);

        return Promise.resolve();
    }
}
