/**
 * Explicit, typed finite state machines for the payment + subscription lifecycles.
 *
 * The machine is a **projection** of provider state: legal transitions advance the row,
 * illegal/stale/out-of-order ones are rejected (no-ops). This is what makes duplicate and
 * reordered webhooks safe by construction. The tables live behind this seam so they can later
 * be extracted into a shared `@lunora/machine` primitive without touching call sites.
 */
import type { PaymentState, SubscriptionState } from "./types";

/**
 * Action that may advance a payment session.
 * @experimental
 */
type PaymentAction = "authorize" | "cancel" | "capture" | "fail" | "partial_refund" | "refund";

/**
 * Action that may advance a subscription.
 * @experimental
 */
type SubscriptionAction = "activate" | "cancel" | "mark_past_due" | "pause" | "renew" | "resume";

const PAYMENT_TRANSITIONS: Record<PaymentState, Partial<Record<PaymentAction, PaymentState>>> = {
    authorized: { cancel: "canceled", capture: "captured", fail: "failed" },
    canceled: {},
    captured: { partial_refund: "partially_refunded", refund: "refunded" },
    // NOT terminal. A failed payment is terminal in our ledger only if the provider also treats it
    // that way, and Stripe does not: a declined PaymentIntent returns to `requires_payment_method`,
    // so the SAME `pi_` can be confirmed again and reach `succeeded` — or `requires_capture` on a
    // manual-capture intent, which arrives as `payment_intent.amount_capturable_updated`. Both are
    // forward transitions at the provider, not out-of-order delivery, so `capture` and `authorize`
    // are legal exits; rejecting them dropped the confirming webhook with a 200 and left the row
    // `failed` with `capturedAmount = 0` while the money was actually taken. `fail` self-loops for a
    // second decline on the same intent (a real event, previously misreported as an illegal
    // transition). Refunds stay illegal: nothing was captured here, so there is nothing to reverse —
    // a refund landing on `failed` is the genuine out-of-order case the FSM should reject.
    failed: { authorize: "authorized", capture: "captured", fail: "failed" },
    // A webhook can land before our local record exists, so "initiated" accepts the same
    // outcomes a fresh intent could reach directly.
    initiated: { authorize: "authorized", cancel: "canceled", capture: "captured", fail: "failed" },
    partially_refunded: { partial_refund: "partially_refunded", refund: "refunded" },
    // Self-loop, not an exit: `refundPayment` records the refund it issued on the row before the
    // provider's confirming `payment.refunded` webhook arrives, so that webhook lands on a row that
    // is ALREADY "refunded". Rejecting it there would strand the refunded total at whatever the
    // facade wrote and drop a provider-side refund entirely. The money stays idempotent because
    // `sync.ts` resolves the amount first: an absolute total resolves to `max(recorded, reported)`,
    // and a delta is rejected as an over-refund once the total already equals the captured amount.
    refunded: { refund: "refunded" },
};

const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionState, Partial<Record<SubscriptionAction, SubscriptionState>>> = {
    active: { cancel: "canceled", mark_past_due: "past_due", pause: "paused", renew: "active" },
    canceled: {},
    past_due: { activate: "active", cancel: "canceled", pause: "paused", renew: "active" },
    paused: { cancel: "canceled", resume: "active" },
    trialing: { activate: "active", cancel: "canceled", mark_past_due: "past_due" },
};

/**
 * `PAYMENT_TERMINAL_STATES` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
const PAYMENT_TERMINAL_STATES: ReadonlySet<PaymentState> = new Set<PaymentState>(["canceled", "refunded"]);

/**
 * `SUBSCRIPTION_TERMINAL_STATES` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
const SUBSCRIPTION_TERMINAL_STATES: ReadonlySet<SubscriptionState> = new Set<SubscriptionState>(["canceled"]);

/**
 * Next payment state for an action, or `undefined` if the transition is illegal from `from`.
 * @experimental
 */
const nextPaymentState = (from: PaymentState, action: PaymentAction): PaymentState | undefined => PAYMENT_TRANSITIONS[from][action];

/**
 * `canTransitionPayment` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
const canTransitionPayment = (from: PaymentState, action: PaymentAction): boolean => nextPaymentState(from, action) !== undefined;

/**
 * Next subscription state for an action, or `undefined` if the transition is illegal from `from`.
 * @experimental
 */
const nextSubscriptionState = (from: SubscriptionState, action: SubscriptionAction): SubscriptionState | undefined => SUBSCRIPTION_TRANSITIONS[from][action];

/**
 * `canTransitionSubscription` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
const canTransitionSubscription = (from: SubscriptionState, action: SubscriptionAction): boolean => nextSubscriptionState(from, action) !== undefined;

export { canTransitionPayment, canTransitionSubscription, nextPaymentState, nextSubscriptionState, PAYMENT_TERMINAL_STATES, SUBSCRIPTION_TERMINAL_STATES };
export type { PaymentAction, SubscriptionAction };
