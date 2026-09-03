/**
 * Core domain types for `@lunora/payment`.
 *
 * The provider is a stateless translator; the store owns all state. These types are the
 * provider-agnostic vocabulary every adapter normalizes onto.
 */

/**
 * ISO-4217 currency code (uppercase, 3 letters). Not enumerated — provider coverage varies.
 */
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

/**
 * Stable provider identifier (Medusa-style). Ships Stripe/Polar/Autumn/Dodo plus Creem, an EU-friendly MoR.
 * @experimental
 */
export type ProviderId = "autumn" | "creem" | "dodopayments" | "polar" | "stripe";

/**
 * What a provider can do — encoded in types so tax/UX assumptions aren't tribal knowledge.
 * @experimental
 */
export interface ProviderCapabilities {
    /** True for Polar / Lemon Squeezy / Paddle; false for Stripe (PSP) and Autumn (runs on your own Stripe). Drives tax/invoice ownership. */
    readonly merchantOfRecord: boolean;
    /** Native hosted customer/billing portal. */
    readonly portal: boolean;
    /** Usage-based / metered billing. */
    readonly usageMetering: boolean;
}

/**
 * Lifecycle state of a one-time payment session.
 * @experimental
 */
export type PaymentState = "authorized" | "canceled" | "captured" | "failed" | "initiated" | "partially_refunded" | "refunded";

/**
 * Lifecycle state of a subscription.
 * @experimental
 */
export type SubscriptionState = "active" | "canceled" | "past_due" | "paused" | "trialing";

/**
 * `Customer` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface Customer {
    readonly createdAt: number;
    readonly email?: string;
    /** Provider-side customer id. */
    readonly id: string;
    readonly provider: ProviderId;
    /** App-side owner the customer belongs to (user / org / workspace). Opaque to this package. */
    readonly referenceId: string;
}

/**
 * `PaymentSession` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
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

/**
 * `Subscription` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
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

/**
 * `CustomerRef` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface CustomerRef {
    readonly email?: string;
    readonly metadata?: Record<string, string>;
    readonly referenceId: string;
}

/**
 * `CheckoutInput` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface CheckoutInput {
    readonly cancelUrl: string;

    /**
     * Ignored at runtime (kept for backward-compat). The provider customer is always derived from the store for the
     * authorized `referenceId` (never caller-supplied) to prevent cross-tenant checkout attachment (IDOR).
     * Retained on the type only for backward compatibility; setting it has no effect.
     */
    readonly customerId?: string;

    /**
     * Customer email, used when the reference has no provider customer yet. Some Merchant-of-Record
     * providers (e.g. Dodo Payments) require an email to mint a customer, so pass it on first checkout.
     */
    readonly email?: string;
    /** Outbound idempotency key for the provider call; auto-derived when omitted. */
    readonly idempotencyKey?: string;
    readonly metadata?: Record<string, string>;
    readonly mode: "payment" | "subscription";
    readonly priceId: string;
    readonly quantity?: number;
    readonly referenceId: string;
    readonly successUrl: string;
}

/**
 * `CheckoutResult` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface CheckoutResult {
    readonly id: string;
    readonly provider: ProviderId;
    readonly url: string;
}

/**
 * `attach` input — subscribe a reference to a plan. A thin, plan-oriented skin over
 * {@link CheckoutInput}: `mode` defaults to `"subscription"` (the common case), so callers pass
 * just `{ referenceId, priceId, successUrl, cancelUrl }`.
 * @experimental
 */
export interface AttachInput extends Omit<CheckoutInput, "mode"> {
    readonly mode?: CheckoutInput["mode"];
}

/**
 * `PortalInput` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface PortalInput {
    readonly customerId: string;
    readonly returnUrl: string;
}

/**
 * A single durable usage record — one metered event for a `(referenceId, featureId)` pair.
 * @experimental
 */
export interface UsageEvent {
    readonly createdAt: number;
    readonly featureId: string;
    /** Caller-stable dedupe key — recording the same key twice is a no-op (exactly-once `track`). */
    readonly idempotencyKey: string;

    /**
     * How the period total absorbs this event: `"add"` (the default, and the value
     * assumed for rows written before this field existed) increments it, `"set"`
     * RESETS it to `quantity` and discards everything recorded earlier in the
     * period.
     *
     * The ledger stays append-only either way — a `"set"` is a marker, not a
     * computed delta — which is what makes `track({ mode: "set" })` safe to call
     * concurrently. `PaymentStore.sumUsage` (via `foldUsage`) applies the fold.
     */
    readonly mode?: "add" | "set";
    readonly provider: ProviderId;

    /** For `"add"`, the increment. For `"set"`, the absolute period total this event declares. */
    readonly quantity: number;
    readonly referenceId: string;
    /** Whether the event was successfully forwarded to the provider's metering API. */
    readonly reportedToProvider: boolean;
}

/**
 * `track` input — record metered usage for a reference's feature.
 * @experimental
 */
export interface TrackInput {
    readonly featureId: string;
    /** Caller-supplied dedupe key; a fresh one is generated when omitted (so each call records). */
    readonly idempotencyKey?: string;

    /**
     * `"add"` (default) increments usage by `quantity`; `"set"` reconciles the period total to `quantity`.
     *
     * Both are a single append: a `"set"` records the absolute target as a marker that the period fold
     * resets to, rather than reading the current total and appending a delta. Concurrent `"set"` calls
     * for the same reference therefore resolve last-writer-wins instead of over- or under-counting, and
     * a replayed `"set"` is idempotent — neither mode needs a serialized context or a per-reference lock.
     */
    readonly mode?: "add" | "set";

    /**
     * Usage amount to add, or the absolute period total when `mode` is `"set"` (defaults to `1`).
     * Must be a non-negative safe integer — a negative value would drive the summed period usage
     * below zero and hand the reference an unbounded metered balance, so it is rejected.
     */
    readonly quantity?: number;
    readonly referenceId: string;
}

/**
 * Result of a `track` call.
 * @experimental
 */
export interface TrackResult {
    /** True when this call inserted a new usage event; false when deduplicated by idempotency key. */
    readonly recorded: boolean;
    /** True when the event was forwarded to the provider's metering API. */
    readonly reportedToProvider: boolean;
}

/**
 * `check` input — is a reference allowed something right now? Pass `featureId` to check a feature
 * grant/allowance, or `priceId` to check active access to a product (one of the two is required).
 * @experimental
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

/**
 * Result of a `check` call.
 * @experimental
 */
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

/**
 * One feature's resolved allowance for a reference — a {@link CheckResult} tagged with its feature.
 * @experimental
 */
export interface FeatureBalance extends CheckResult {
    readonly featureId: string;
}

/**
 * Input the adapter forwards to the provider's metering API (Stripe Meter Events / Polar ingestion).
 * @experimental
 */
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

/**
 * `CaptureInput` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface CaptureInput {
    /** Partial capture amount; full capture when omitted. */
    readonly amount?: Money;
    readonly idempotencyKey?: string;
    readonly sessionId: string;
}

/**
 * `RefundInput` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface RefundInput {
    /** Partial refund amount; full refund when omitted. */
    readonly amount?: Money;
    readonly idempotencyKey?: string;
    readonly reason?: string;
    readonly sessionId: string;
}

/**
 * What an adapter's `refundPayment` returns: the provider-shaped session, plus the provider's own id
 * for the refund it just issued.
 *
 * `RefundResult` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface RefundResult extends PaymentSession {
    /**
     * The provider accepted the refund but has NOT moved the money yet — Dodo answers
     * `refunds.create` with `pending`/`review` and settles later via `refund.succeeded`, or never,
     * via `refund.failed`. The facade leaves its ledger untouched for one of these and lets the
     * confirming webhook carry the money, because a `refund.failed` reverses nothing. Absent (the
     * default) means the refund is already settled — Stripe and Polar refund synchronously.
     */
    readonly pending?: boolean;

    /**
     * The provider's id for THIS refund — Stripe and Polar `Refund.id`, Dodo `refund_id`. It is the
     * identity the facade keys its local refund marker on, so two in-flight refunds of the same
     * amount on one session stay distinct. `undefined` only where a provider reports no id, which
     * falls the marker back to the (colliding) amount.
     */
    readonly refundId?: string;
}

/**
 * `CancelSubscriptionOptions` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface CancelSubscriptionOptions {
    /** Cancel at period end instead of immediately. */
    readonly atPeriodEnd?: boolean;
    readonly idempotencyKey?: string;
}

/**
 * `SubscriptionPatch` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface SubscriptionPatch {
    readonly priceId?: string;
    readonly quantity?: number;
}

/**
 * Normalized webhook outcome — the *core state transition* a provider event implies.
 * @experimental
 */
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

/**
 * How a refund action's {@link WebhookAction.amount} should be interpreted by the sync layer.
 *
 * `"delta"` is an incremental amount added to the running refunded total (Polar `refund.created`,
 * and the historical default), so multiple events accumulate. `"absolute"` is the provider's
 * cumulative refunded-to-date total (Stripe `charge.refunded` carries `amount_refunded`, which
 * already sums all prior partial refunds); the sync layer sets the refunded total to this value
 * rather than adding, so repeated partial-refund events do not over-count.
 *
 * Omitted means `"delta"`, preserving the original behavior for callers that predate this field.
 * @experimental
 */
export type RefundAmountKind = "absolute" | "delta";

/**
 * `WebhookAction` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface WebhookAction {
    readonly amount?: Money;

    /**
     * Interpretation of {@link WebhookAction.amount} for refund actions (`payment.refunded`).
     * Defaults to `"delta"` when omitted. Ignored for non-refund actions.
     */
    readonly amountKind?: RefundAmountKind;
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

    /**
     * Provider id of the refund this event reports (refund actions only). Carries the per-refund
     * identity the sync layer matches against the marker `refundPayment` left behind, so a second
     * facade refund of the same amount is not mistaken for the first one's confirmation.
     */
    readonly refundId?: string;
    readonly sessionId?: string;
    readonly subscriptionId?: string;
    readonly type: WebhookActionType;
}

/**
 * Result of applying a webhook action to the store.
 * @experimental
 */
export interface ApplyResult {
    readonly applied: boolean;
    readonly reason?: "duplicate" | "illegal_transition" | "invalid_refund_amount" | "ok" | "orphaned" | "unhandled";
}
