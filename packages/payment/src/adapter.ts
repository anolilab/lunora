import { CirrusPaymentError } from "./errors";
import type {
    CancelSubscriptionOptions,
    CaptureInput,
    CheckoutInput,
    CheckoutResult,
    Customer,
    CustomerRef,
    PaymentSession,
    PortalInput,
    ProviderCapabilities,
    ProviderId,
    RefundInput,
    ReportUsageInput,
    Subscription,
    SubscriptionPatch,
    WebhookAction,
} from "./types";

/** A read-only header bag; the platform `Headers` object satisfies it. */
export interface WebhookHeaders {
    get: (name: string) => null | string;
}

export interface WebhookInput {
    /** Request headers (signature schemes read provider-specific headers from here). */
    readonly headers: WebhookHeaders;
    /** Raw request body, exactly as received (required for signature verification). */
    readonly payload: string;
}

/**
 * A stateless translator between the provider API and Cirrus's normalized vocabulary.
 *
 * Adapters never own state — they make provider calls and normalize provider events into a
 * `WebhookAction`. All durable state lives in the payment store.
 */
export interface PaymentAdapter {
    cancelPayment: (sessionId: string, options?: { idempotencyKey?: string }) => Promise<PaymentSession>;
    cancelSubscription: (subscriptionId: string, options?: CancelSubscriptionOptions) => Promise<Subscription>;
    readonly capabilities: ProviderCapabilities;
    capturePayment: (input: CaptureInput) => Promise<PaymentSession>;
    createCheckout: (input: CheckoutInput) => Promise<CheckoutResult>;
    createPortalSession: (input: PortalInput) => Promise<{ url: string }>;
    getOrCreateCustomer: (ref: CustomerRef) => Promise<Customer>;
    /** Fetch the provider's current truth for a payment session — the basis for reconciliation. */
    getPaymentStatus: (sessionId: string) => Promise<PaymentSession>;
    /** Fetch the provider's current truth for a subscription — the basis for reconciliation. */
    getSubscriptionStatus: (subscriptionId: string) => Promise<Subscription>;
    /** Stable provider identifier (Medusa-style). */
    readonly identifier: ProviderId;
    /** Verify the signature over the raw body, then normalize the event. Throws on invalid signature. */
    parseWebhook: (input: WebhookInput) => Promise<WebhookAction>;
    refundPayment: (input: RefundInput) => Promise<PaymentSession>;

    /**
     * Forward metered usage to the provider's billing API. Optional — present only on providers
     * whose `capabilities.usageMetering` is `true` and that expose an ingestion endpoint. When
     * absent, `track` still records usage durably and `check` enforces limits locally.
     */
    reportUsage?: (input: ReportUsageInput) => Promise<void>;
    resumeSubscription: (subscriptionId: string) => Promise<Subscription>;
    updateSubscription: (subscriptionId: string, patch: SubscriptionPatch) => Promise<Subscription>;
}

/** Registry of adapters keyed by provider id — supports dual-register during provider migration. */
export interface AdapterRegistry {
    all: () => PaymentAdapter[];
    get: (provider: ProviderId) => PaymentAdapter;
    has: (provider: ProviderId) => boolean;
}

export const createAdapterRegistry = (adapters: ReadonlyArray<PaymentAdapter>): AdapterRegistry => {
    const byId = new Map<ProviderId, PaymentAdapter>();

    for (const adapter of adapters) {
        if (byId.has(adapter.identifier)) {
            throw new CirrusPaymentError("CONFIG_INVALID", `duplicate adapter for provider "${adapter.identifier}"`);
        }

        byId.set(adapter.identifier, adapter);
    }

    return {
        all: () => [...byId.values()],
        get: (provider) => {
            const adapter = byId.get(provider);

            if (!adapter) {
                throw new CirrusPaymentError("CONFIG_INVALID", `no adapter registered for provider "${provider}"`);
            }

            return adapter;
        },
        has: (provider) => byId.has(provider),
    };
};
