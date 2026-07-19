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
     * Claims a provider event id for processing. Resolves `true` the first time an event is seen
     * and `false` for a duplicate — the inbound-idempotency primitive.
     */
    markEventProcessed: (provider: ProviderId, eventId: string) => Promise<boolean>;
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
    /** Sum recorded usage `quantity` for a `(referenceId, featureId)` pair since `since` (epoch ms). */
    sumUsage: (referenceId: string, featureId: string, since: number) => Promise<number>;
    upsertCustomer: (customer: Customer) => Promise<void>;
    upsertPaymentSession: (session: PaymentSession) => Promise<void>;
    upsertSubscription: (subscription: Subscription) => Promise<void>;
}

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

    public markEventProcessed(provider: ProviderId, eventId: string): Promise<boolean> {
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
        let total = 0;

        for (const event of this.usageEvents.values()) {
            if (event.referenceId === referenceId && event.featureId === featureId && event.createdAt >= since) {
                total += event.quantity;
            }
        }

        return Promise.resolve(total);
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
