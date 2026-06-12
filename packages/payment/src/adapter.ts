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
    Subscription,
    SubscriptionPatch,
    WebhookAction,
} from "./types";

export interface WebhookInput {
    /** Raw request body, exactly as received (required for signature verification). */
    readonly payload: string;
    /** Provider signature header value. */
    readonly signatureHeader: string;
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
    /** Stable provider identifier (Medusa-style). */
    readonly identifier: ProviderId;
    /** Verify the signature over the raw body, then normalize the event. Throws on invalid signature. */
    parseWebhook: (input: WebhookInput) => Promise<WebhookAction>;
    refundPayment: (input: RefundInput) => Promise<PaymentSession>;
    resumeSubscription: (subscriptionId: string) => Promise<Subscription>;
    updateSubscription: (subscriptionId: string, patch: SubscriptionPatch) => Promise<Subscription>;
    /** Request header carrying the provider's webhook signature (e.g. `stripe-signature`). */
    readonly webhookSignatureHeader: string;
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
