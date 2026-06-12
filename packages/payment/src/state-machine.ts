/**
 * Explicit, typed finite state machines for the payment + subscription lifecycles.
 *
 * The machine is a **projection** of provider state: legal transitions advance the row,
 * illegal/stale/out-of-order ones are rejected (no-ops). This is what makes duplicate and
 * reordered webhooks safe by construction. The tables live behind this seam so they can later
 * be extracted into a shared `@cirrus/machine` primitive without touching call sites.
 */
import type { PaymentState, SubscriptionState } from "./types";

/** Action that may advance a payment session. */
type PaymentAction = "authorize" | "cancel" | "capture" | "fail" | "partial_refund" | "refund";

/** Action that may advance a subscription. */
type SubscriptionAction = "activate" | "cancel" | "mark_past_due" | "pause" | "renew" | "resume";

const PAYMENT_TRANSITIONS: Record<PaymentState, Partial<Record<PaymentAction, PaymentState>>> = {
    authorized: { cancel: "canceled", capture: "captured", fail: "failed" },
    canceled: {},
    captured: { partial_refund: "partially_refunded", refund: "refunded" },
    failed: {},
    // A webhook can land before our local record exists, so "initiated" accepts the same
    // outcomes a fresh intent could reach directly.
    initiated: { authorize: "authorized", cancel: "canceled", capture: "captured", fail: "failed" },
    partially_refunded: { partial_refund: "partially_refunded", refund: "refunded" },
    refunded: {},
};

const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionState, Partial<Record<SubscriptionAction, SubscriptionState>>> = {
    active: { cancel: "canceled", mark_past_due: "past_due", pause: "paused", renew: "active" },
    canceled: {},
    past_due: { activate: "active", cancel: "canceled", pause: "paused", renew: "active" },
    paused: { cancel: "canceled", resume: "active" },
    trialing: { activate: "active", cancel: "canceled", mark_past_due: "past_due" },
};

const PAYMENT_TERMINAL_STATES: ReadonlySet<PaymentState> = new Set<PaymentState>(["canceled", "failed", "refunded"]);

const SUBSCRIPTION_TERMINAL_STATES: ReadonlySet<SubscriptionState> = new Set<SubscriptionState>(["canceled"]);

/** Next payment state for an action, or `undefined` if the transition is illegal from `from`. */
const nextPaymentState = (from: PaymentState, action: PaymentAction): PaymentState | undefined => PAYMENT_TRANSITIONS[from][action];

const canTransitionPayment = (from: PaymentState, action: PaymentAction): boolean => nextPaymentState(from, action) !== undefined;

/** Next subscription state for an action, or `undefined` if the transition is illegal from `from`. */
const nextSubscriptionState = (from: SubscriptionState, action: SubscriptionAction): SubscriptionState | undefined => SUBSCRIPTION_TRANSITIONS[from][action];

const canTransitionSubscription = (from: SubscriptionState, action: SubscriptionAction): boolean => nextSubscriptionState(from, action) !== undefined;

export { canTransitionPayment, canTransitionSubscription, nextPaymentState, nextSubscriptionState, PAYMENT_TERMINAL_STATES, SUBSCRIPTION_TERMINAL_STATES };
export type { PaymentAction, SubscriptionAction };
