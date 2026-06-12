/**
 * The durable sync store seam.
 *
 * `PaymentStore` is the single interface the engine writes through. The in-memory implementation
 * here backs tests and local dev; a Durable-Object-backed implementation (SQLite + OCC) drops in
 * behind the same interface for production without touching call sites.
 */
import type { Customer, PaymentSession, ProviderId, Subscription } from "./types";

const customerKey = (provider: ProviderId, referenceId: string): string => `${provider}:${referenceId}`;

const recordKey = (provider: ProviderId, id: string): string => `${provider}:${id}`;

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
    upsertCustomer: (customer: Customer) => Promise<void>;
    upsertPaymentSession: (session: PaymentSession) => Promise<void>;
    upsertSubscription: (subscription: Subscription) => Promise<void>;
}

/** In-memory {@link PaymentStore} for tests and local development. Not durable. */
export class MemoryPaymentStore implements PaymentStore {
    private readonly customers = new Map<string, Customer>();

    private readonly processedEvents = new Set<string>();

    private readonly sessions = new Map<string, PaymentSession>();

    private readonly subscriptions = new Map<string, Subscription>();

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
