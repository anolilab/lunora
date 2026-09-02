import { LunoraPaymentError } from "./errors";
import type {
    CancelSubscriptionOptions,
    CaptureInput,
    CheckInput,
    CheckoutInput,
    CheckoutResult,
    CheckResult,
    Customer,
    CustomerRef,
    FeatureBalance,
    PaymentSession,
    PortalInput,
    ProviderCapabilities,
    ProviderId,
    RefundInput,
    RefundResult,
    ReportUsageInput,
    Subscription,
    SubscriptionPatch,
    WebhookAction,
} from "./types";

/**
 * A read-only header bag; the platform `Headers` object satisfies it.
 * @experimental
 */
export interface WebhookHeaders {
    get: (name: string) => null | string;
}

/**
 * `WebhookInput` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface WebhookInput {
    /** Request headers (signature schemes read provider-specific headers from here). */
    readonly headers: WebhookHeaders;
    /** Raw request body, exactly as received (required for signature verification). */
    readonly payload: string;
}

/**
 * A stateless translator between the provider API and Lunora's normalized vocabulary.
 *
 * Adapters never own state — they make provider calls and normalize provider events into a
 * `WebhookAction`. All durable state lives in the payment store.
 * @experimental
 */
export interface PaymentAdapter {
    cancelPayment: (sessionId: string, options?: { idempotencyKey?: string }) => Promise<PaymentSession>;
    cancelSubscription: (subscriptionId: string, options?: CancelSubscriptionOptions) => Promise<Subscription>;
    readonly capabilities: ProviderCapabilities;
    capturePayment: (input: CaptureInput) => Promise<PaymentSession>;

    /**
     * Ask the provider whether a reference may consume `quantity` units of a feature (or holds active
     * access to a product) right now — for providers that own entitlement truth themselves (e.g.
     * Autumn computes balances, credits, and limits from its plan config). Optional: when absent, the
     * facade's `check` evaluates locally from the synced store + the app's `entitlements` config. When
     * present, the facade delegates `check` to it, so `entitlements` need not be configured.
     */
    checkEntitlement?: (input: CheckInput) => Promise<CheckResult>;

    createCheckout: (input: CheckoutInput) => Promise<CheckoutResult>;
    createPortalSession: (input: PortalInput) => Promise<{ url: string }>;

    /**
     * Resolve every feature allowance for a reference straight from the provider — the optional
     * companion to `checkEntitlement` that powers `listBalances`. Present only on providers that
     * own entitlement truth; when absent, the facade evaluates balances locally from the store + the
     * app's `entitlements` config.
     */
    getBalances?: (referenceId: string) => Promise<FeatureBalance[]>;

    getOrCreateCustomer: (ref: CustomerRef) => Promise<Customer>;
    /** Fetch the provider's current truth for a payment session — the basis for reconciliation. */
    getPaymentStatus: (sessionId: string) => Promise<PaymentSession>;
    /** Fetch the provider's current truth for a subscription — the basis for reconciliation. */
    getSubscriptionStatus: (subscriptionId: string) => Promise<Subscription>;
    /** Stable provider identifier (Medusa-style). */
    readonly identifier: ProviderId;
    /** Verify the signature over the raw body, then normalize the event. Throws on invalid signature. */
    parseWebhook: (input: WebhookInput) => Promise<WebhookAction>;
    /** Issue the refund and report the provider's id for it (see {@link RefundResult.refundId}). */
    refundPayment: (input: RefundInput) => Promise<RefundResult>;

    /**
     * Forward metered usage to the provider's billing API. Optional — present only on providers
     * whose `capabilities.usageMetering` is `true` and that expose an ingestion endpoint. When
     * absent, `track` still records usage durably and `check` enforces limits locally.
     */
    reportUsage?: (input: ReportUsageInput) => Promise<void>;
    resumeSubscription: (subscriptionId: string) => Promise<Subscription>;
    updateSubscription: (subscriptionId: string, patch: SubscriptionPatch) => Promise<Subscription>;
}

/**
 * Registry of adapters keyed by provider id — supports dual-register during provider migration.
 * @experimental
 */
export interface AdapterRegistry {
    all: () => PaymentAdapter[];
    get: (provider: ProviderId) => PaymentAdapter;
    has: (provider: ProviderId) => boolean;
}

/**
 * `createAdapterRegistry` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const createAdapterRegistry = (adapters: ReadonlyArray<PaymentAdapter>): AdapterRegistry => {
    const byId = new Map<ProviderId, PaymentAdapter>();

    for (const adapter of adapters) {
        if (byId.has(adapter.identifier)) {
            throw new LunoraPaymentError("CONFIG_INVALID", `duplicate adapter for provider "${adapter.identifier}"`);
        }

        byId.set(adapter.identifier, adapter);
    }

    return {
        all: () => [...byId.values()],
        get: (provider) => {
            const adapter = byId.get(provider);

            if (!adapter) {
                throw new LunoraPaymentError("CONFIG_INVALID", `no adapter registered for provider "${provider}"`);
            }

            return adapter;
        },
        has: (provider) => byId.has(provider),
    };
};
