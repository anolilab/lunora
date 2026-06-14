/**
 * Core domain types for `@cirrus/payment`.
 *
 * The provider is a stateless translator; the store owns all state. These types are the
 * provider-agnostic vocabulary every adapter normalizes onto.
 */

/** ISO-4217 currency code (uppercase, 3 letters). Not enumerated — provider coverage varies. */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- a documented semantic alias, intentional
export type CurrencyCode = string;

/**
 * Money as integer minor units + currency. Always carry the two together.
 *
 * `minorUnits` is a `bigint`, which is **not** JSON-serializable — cross the RPC/wire boundary
 * with the `toMoneyJSON` / `fromMoneyJSON` helpers (see `./money`).
 */
export interface Money {
    readonly currency: CurrencyCode;
    readonly minorUnits: bigint;
}

/** Stable provider identifier (Medusa-style). Scoped to what Convex ships: Stripe + Polar. */
export type ProviderId = "polar" | "stripe";

/** What a provider can do — encoded in types so tax/UX assumptions aren't tribal knowledge. */
export interface ProviderCapabilities {
    /** True for Polar / Lemon Squeezy / Paddle; false for Stripe (PSP). Drives tax/invoice ownership. */
    readonly merchantOfRecord: boolean;
    /** Native hosted customer/billing portal. */
    readonly portal: boolean;
    /** Usage-based / metered billing. */
    readonly usageMetering: boolean;
}

/** Lifecycle state of a one-time payment session. */
export type PaymentState = "authorized" | "canceled" | "captured" | "failed" | "initiated" | "partially_refunded" | "refunded";

/** Lifecycle state of a subscription. */
export type SubscriptionState = "active" | "canceled" | "past_due" | "paused" | "trialing";

export interface Customer {
    readonly createdAt: number;
    readonly email?: string;
    /** Provider-side customer id. */
    readonly id: string;
    readonly provider: ProviderId;
    /** App-side owner the customer belongs to (user / org / workspace). Opaque to this package. */
    readonly referenceId: string;
}

export interface PaymentSession {
    readonly amount: Money;
    readonly capturedAmount: Money;
    readonly createdAt: number;
    /** Provider-side payment / intent / session id. */
    readonly id: string;
    readonly provider: ProviderId;
    readonly referenceId: string;
    readonly refundedAmount: Money;
    readonly state: PaymentState;
    readonly updatedAt: number;
}

export interface Subscription {
    readonly cancelAtPeriodEnd: boolean;
    readonly createdAt: number;
    readonly currentPeriodEnd?: number;
    /** Start of the current billing period — the window `check` sums metered usage over. */
    readonly currentPeriodStart?: number;
    readonly id: string;
    readonly priceId: string;
    readonly provider: ProviderId;
    readonly quantity: number;
    readonly referenceId: string;
    readonly state: SubscriptionState;
    readonly updatedAt: number;
}

export interface CustomerRef {
    readonly email?: string;
    readonly metadata?: Record<string, string>;
    readonly referenceId: string;
}

export interface CheckoutInput {
    readonly cancelUrl: string;
    /** Existing provider customer id, if known. */
    readonly customerId?: string;
    /** Outbound idempotency key for the provider call; auto-derived when omitted. */
    readonly idempotencyKey?: string;
    readonly metadata?: Record<string, string>;
    readonly mode: "payment" | "subscription";
    readonly priceId: string;
    readonly quantity?: number;
    readonly referenceId: string;
    readonly successUrl: string;
}

export interface CheckoutResult {
    readonly id: string;
    readonly provider: ProviderId;
    readonly url: string;
}

/**
 * `attach` input — subscribe a reference to a plan. A thin, plan-oriented skin over
 * {@link CheckoutInput}: `mode` defaults to `"subscription"` (the common case), so callers pass
 * just `{ referenceId, priceId, successUrl, cancelUrl }`.
 */
export interface AttachInput extends Omit<CheckoutInput, "mode"> {
    readonly mode?: CheckoutInput["mode"];
}

export interface PortalInput {
    readonly customerId: string;
    readonly returnUrl: string;
}

/** A single durable usage record — one metered event for a `(referenceId, featureId)` pair. */
export interface UsageEvent {
    readonly createdAt: number;
    readonly featureId: string;
    /** Caller-stable dedupe key — recording the same key twice is a no-op (exactly-once `track`). */
    readonly idempotencyKey: string;
    readonly provider: ProviderId;
    readonly quantity: number;
    readonly referenceId: string;
    /** Whether the event was successfully forwarded to the provider's metering API. */
    readonly reportedToProvider: boolean;
}

/** `track` input — record metered usage for a reference's feature. */
export interface TrackInput {
    readonly featureId: string;
    /** Caller-supplied dedupe key; a fresh one is generated when omitted (so each call records). */
    readonly idempotencyKey?: string;
    /** `"add"` (default) increments usage by `quantity`; `"set"` reconciles the period total to `quantity`. */
    readonly mode?: "add" | "set";
    /** Usage amount to add, or the absolute period total when `mode` is `"set"` (defaults to `1`). */
    readonly quantity?: number;
    readonly referenceId: string;
}

/** Result of a `track` call. */
export interface TrackResult {
    /** True when this call inserted a new usage event; false when deduplicated by idempotency key. */
    readonly recorded: boolean;
    /** True when the event was forwarded to the provider's metering API. */
    readonly reportedToProvider: boolean;
}

/**
 * `check` input — is a reference allowed something right now? Pass `featureId` to check a feature
 * grant/allowance, or `priceId` to check active access to a product (one of the two is required).
 */
export interface CheckInput {
    /** Feature to check a grant/allowance for. Provide this **or** `priceId`. */
    readonly featureId?: string;
    /** Provider price/product id to check active access for. Provide this **or** `featureId`. */
    readonly priceId?: string;
    /** Units the caller intends to consume; the check passes only when this many remain (default `1`). */
    readonly quantity?: number;
    readonly referenceId: string;
}

/** Result of a `check` call. */
export interface CheckResult {
    /** Whether the reference may consume `quantity` units of the feature right now. */
    readonly allowed: boolean;
    /** Remaining units this period (`limit - used`), for metered features only. */
    readonly balance?: number;
    /** The plan-granted cap, for metered features only. */
    readonly limit?: number;
    /** True for a boolean feature granted without a numeric cap. */
    readonly unlimited: boolean;
    /** Usage consumed this period, for metered features only. */
    readonly used?: number;
}

/** One feature's resolved allowance for a reference — a {@link CheckResult} tagged with its feature. */
export interface FeatureBalance extends CheckResult {
    readonly featureId: string;
}

/** Input the adapter forwards to the provider's metering API (Stripe Meter Events / Polar ingestion). */
export interface ReportUsageInput {
    /** Provider customer id, when known (Stripe meter events key on it). */
    readonly customerId?: string;
    readonly featureId: string;
    readonly idempotencyKey: string;
    readonly quantity: number;
    readonly referenceId: string;
    /** Event time in epoch ms; defaults to now at the provider. */
    readonly timestamp?: number;
}

export interface CaptureInput {
    /** Partial capture amount; full capture when omitted. */
    readonly amount?: Money;
    readonly idempotencyKey?: string;
    readonly sessionId: string;
}

export interface RefundInput {
    /** Partial refund amount; full refund when omitted. */
    readonly amount?: Money;
    readonly idempotencyKey?: string;
    readonly reason?: string;
    readonly sessionId: string;
}

export interface CancelSubscriptionOptions {
    /** Cancel at period end instead of immediately. */
    readonly atPeriodEnd?: boolean;
    readonly idempotencyKey?: string;
}

export interface SubscriptionPatch {
    readonly priceId?: string;
    readonly quantity?: number;
}

/** Normalized webhook outcome — the *core state transition* a provider event implies. */
export type WebhookActionType =
    | "payment.authorized"
    | "payment.captured"
    | "payment.failed"
    | "payment.refunded"
    | "subscription.active"
    | "subscription.canceled"
    | "subscription.past_due"
    | "subscription.paused"
    | "subscription.updated"
    | "unhandled";

export interface WebhookAction {
    readonly amount?: Money;
    readonly cancelAtPeriodEnd?: boolean;
    readonly currentPeriodEnd?: number;
    readonly currentPeriodStart?: number;
    readonly customerId?: string;
    /** Provider event id — the inbound idempotency key. */
    readonly eventId: string;
    readonly priceId?: string;
    readonly provider: ProviderId;
    readonly quantity?: number;
    /** Raw provider event, retained for the events log / debugging. */
    readonly raw?: unknown;
    readonly referenceId?: string;
    readonly sessionId?: string;
    readonly subscriptionId?: string;
    readonly type: WebhookActionType;
}

/** Result of applying a webhook action to the store. */
export interface ApplyResult {
    readonly applied: boolean;
    readonly reason?: "duplicate" | "illegal_transition" | "invalid_refund_amount" | "ok" | "unhandled";
}
