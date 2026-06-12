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

/** Stable provider identifier (Medusa-style). */
export type ProviderId = "lemonsqueezy" | "paddle" | "polar" | "stripe";

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

export interface PortalInput {
    readonly customerId: string;
    readonly returnUrl: string;
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
    readonly reason?: "duplicate" | "illegal_transition" | "ok" | "unhandled";
}
