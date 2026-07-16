/**
 * Apply a normalized {@link WebhookAction} to the {@link PaymentStore}.
 *
 * Flow: claim the event id (inbound idempotency) → map the action to an FSM transition → upsert
 * if legal, otherwise no-op. Duplicate and out-of-order webhooks are absorbed here, not by the
 * caller.
 */
import { addMoney, compareMoney, zeroMoney } from "./money";
import type { PaymentObserver } from "./observability";
import { notifyObserver } from "./observability";
import type { PaymentAction, SubscriptionAction } from "./state-machine";
import { nextPaymentState, nextSubscriptionState } from "./state-machine";
import type { PaymentStore } from "./store";
import type { ApplyResult, Money, PaymentSession, PaymentState, SubscriptionState, WebhookAction, WebhookActionType } from "./types";

const PAYMENT_ACTION_BY_TYPE: Partial<Record<WebhookActionType, PaymentAction>> = {
    "payment.authorized": "authorize",
    "payment.captured": "capture",
    "payment.failed": "fail",
    "payment.refunded": "refund",
};

const SUBSCRIPTION_STATE_BY_TYPE: Partial<Record<WebhookActionType, SubscriptionState>> = {
    "subscription.active": "active",
    "subscription.canceled": "canceled",
    "subscription.past_due": "past_due",
    "subscription.paused": "paused",
};

const SUBSCRIPTION_ACTION_BY_TYPE: Partial<Record<WebhookActionType, SubscriptionAction>> = {
    "subscription.active": "activate",
    "subscription.canceled": "cancel",
    "subscription.past_due": "mark_past_due",
    "subscription.paused": "pause",
};

/** The larger of two same-currency amounts. */
const maxMoney = (a: Money, b: Money): Money => (compareMoney(a, b) > 0 ? a : b);

/**
 * Compute the new refunded total a refund action implies, honoring its `amountKind`.
 *
 * `"delta"` (the default, Polar `refund.created`) adds `amount` to the current refunded total, so
 * events accumulate. `"absolute"` (Stripe `charge.refunded`'s `amount_refunded`) is the provider's
 * cumulative refunded-to-date, so the total becomes `max(current, amount)` — a re-delivered or stale
 * cumulative total never moves the running total backward, and multiple partials never over-count.
 *
 * Returns `undefined` when the action is malformed for refund math — the currency disagrees with the
 * running totals, or the resulting total exceeds the captured amount — so the caller can no-op cleanly
 * instead of letting `addMoney`/`compareMoney` throw CURRENCY_MISMATCH past the claimed event id
 * (which would turn the retry into a lost event).
 */
const refundedTotalFor = (base: PaymentSession, action: WebhookAction): Money | undefined => {
    if (!action.amount) {
        return undefined;
    }

    if (base.refundedAmount.currency !== action.amount.currency || base.capturedAmount.currency !== action.amount.currency) {
        return undefined;
    }

    const prospective = action.amountKind === "absolute" ? maxMoney(action.amount, base.refundedAmount) : addMoney(base.refundedAmount, action.amount);

    if (compareMoney(prospective, base.capturedAmount) > 0) {
        return undefined;
    }

    return prospective;
};

const applyPayment = async (store: PaymentStore, action: WebhookAction, paymentAction: PaymentAction): Promise<ApplyResult> => {
    if (!action.sessionId) {
        return { applied: false, reason: "unhandled" };
    }

    const existing = await store.getPaymentSession(action.provider, action.sessionId);
    const fromState: PaymentState = existing?.state ?? "initiated";
    const now = Date.now();
    const currency = action.amount?.currency ?? existing?.amount.currency ?? "USD";

    let resolvedAction = paymentAction;

    // A refund is "partial" while the resulting refunded total stays below the captured total.
    // `refundedTotalFor` resolves absolute-vs-delta semantics so the partial/full decision and the
    // stored amount agree.
    if (paymentAction === "refund" && existing) {
        const prospective = refundedTotalFor(existing, action);

        if (prospective && compareMoney(prospective, existing.capturedAmount) < 0) {
            resolvedAction = "partial_refund";
        }
    }

    const toState = nextPaymentState(fromState, resolvedAction);

    if (!toState) {
        return { applied: false, reason: "illegal_transition" };
    }

    const base: PaymentSession = existing ?? {
        amount: action.amount ?? zeroMoney(currency),
        capturedAmount: zeroMoney(currency),
        createdAt: now,
        id: action.sessionId,
        provider: action.provider,
        referenceId: action.referenceId ?? "",
        refundedAmount: zeroMoney(currency),
        state: fromState,
        updatedAt: now,
    };

    let { capturedAmount, refundedAmount } = base;

    if (resolvedAction === "capture" && action.amount) {
        capturedAmount = action.amount;
    }

    if ((resolvedAction === "partial_refund" || resolvedAction === "refund") && action.amount) {
        const prospective = refundedTotalFor(base, action);

        if (!prospective) {
            return { applied: false, reason: "invalid_refund_amount" };
        }

        refundedAmount = prospective;
    }

    await store.upsertPaymentSession({
        ...base,
        capturedAmount,
        referenceId: action.referenceId ?? base.referenceId,
        refundedAmount,
        state: toState,
        updatedAt: now,
    });

    return { applied: true, reason: "ok" };
};

const applySubscription = async (store: PaymentStore, action: WebhookAction): Promise<ApplyResult> => {
    if (!action.subscriptionId) {
        return { applied: false, reason: "unhandled" };
    }

    const existing = await store.getSubscription(action.provider, action.subscriptionId);
    const now = Date.now();

    // A pure metadata change (price / quantity / cancel-at-period-end) with no state transition.
    if (action.type === "subscription.updated") {
        if (!existing) {
            return { applied: false, reason: "unhandled" };
        }

        await store.upsertSubscription({
            ...existing,
            cancelAtPeriodEnd: action.cancelAtPeriodEnd ?? existing.cancelAtPeriodEnd,
            currentPeriodEnd: action.currentPeriodEnd ?? existing.currentPeriodEnd,
            currentPeriodStart: action.currentPeriodStart ?? existing.currentPeriodStart,
            priceId: action.priceId ?? existing.priceId,
            quantity: action.quantity ?? existing.quantity,
            updatedAt: now,
        });

        return { applied: true, reason: "ok" };
    }

    const targetState = SUBSCRIPTION_STATE_BY_TYPE[action.type];

    if (!targetState) {
        return { applied: false, reason: "unhandled" };
    }

    if (!existing) {
        await store.upsertSubscription({
            cancelAtPeriodEnd: action.cancelAtPeriodEnd ?? false,
            createdAt: now,
            currentPeriodEnd: action.currentPeriodEnd,
            currentPeriodStart: action.currentPeriodStart ?? now,
            id: action.subscriptionId,
            priceId: action.priceId ?? "",
            provider: action.provider,
            quantity: action.quantity ?? 1,
            referenceId: action.referenceId ?? "",
            state: targetState,
            updatedAt: now,
        });

        return { applied: true, reason: "ok" };
    }

    // A repeated "active" (renewal/period roll) is a legal self-loop; otherwise use the mapped action.
    const subscriptionAction: SubscriptionAction | undefined =
        existing.state === "active" && targetState === "active" ? "renew" : SUBSCRIPTION_ACTION_BY_TYPE[action.type];

    const nextState = subscriptionAction ? nextSubscriptionState(existing.state, subscriptionAction) : undefined;

    if (!nextState) {
        return { applied: false, reason: "illegal_transition" };
    }

    await store.upsertSubscription({
        ...existing,
        cancelAtPeriodEnd: action.cancelAtPeriodEnd ?? existing.cancelAtPeriodEnd,
        currentPeriodEnd: action.currentPeriodEnd ?? existing.currentPeriodEnd,
        currentPeriodStart: action.currentPeriodStart ?? existing.currentPeriodStart,
        priceId: action.priceId ?? existing.priceId,
        quantity: action.quantity ?? existing.quantity,
        state: nextState,
        updatedAt: now,
    });

    return { applied: true, reason: "ok" };
};

/**
 * `applyWebhookAction` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
const applyWebhookAction = async (store: PaymentStore, action: WebhookAction, observer?: PaymentObserver): Promise<ApplyResult> => {
    if (action.type === "unhandled") {
        return { applied: false, reason: "unhandled" };
    }

    const fresh = await store.markEventProcessed(action.provider, action.eventId);

    if (!fresh) {
        notifyObserver(observer, { eventId: action.eventId, provider: action.provider, type: "webhook.duplicate" });

        return { applied: false, reason: "duplicate" };
    }

    const paymentAction = PAYMENT_ACTION_BY_TYPE[action.type];

    let result: ApplyResult;

    try {
        result = paymentAction ? await applyPayment(store, action, paymentAction) : await applySubscription(store, action);
    } catch (error) {
        // The claim is taken before apply; a genuine store-write failure would otherwise leave the
        // event marked-processed so the provider's retry dedupes to a lost effect. Release the claim
        // so the retry re-processes, then rethrow so the caller returns non-2xx and the provider
        // retries. The atomic insert-claim still guards concurrent duplicates: only the caller that
        // won the claim reaches (and rolls back) this path.
        await store.releaseEvent(action.provider, action.eventId);

        throw error;
    }

    notifyObserver(observer, { action: action.type, eventId: action.eventId, provider: action.provider, reason: result.reason, type: "webhook.applied" });

    // Alertable signals — emitted on the provider's report regardless of the FSM outcome.
    if (action.type === "payment.failed") {
        notifyObserver(observer, { provider: action.provider, referenceId: action.referenceId, sessionId: action.sessionId, type: "payment.failed" });
    } else if (action.type === "subscription.past_due") {
        notifyObserver(observer, {
            provider: action.provider,
            referenceId: action.referenceId,
            subscriptionId: action.subscriptionId,
            type: "subscription.past_due",
        });
    }

    return result;
};

export default applyWebhookAction;
