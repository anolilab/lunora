/**
 * Apply a normalized {@link WebhookAction} to the {@link PaymentStore}.
 *
 * Flow: claim the event id (inbound idempotency) → map the action to an FSM transition → upsert
 * if legal, otherwise no-op. Duplicate and out-of-order webhooks are absorbed here, not by the
 * caller — with one exception: an event that arrives before the row it patches is ready (a
 * subscription update before its create, a refund before its capture) reports `"orphaned"`, which
 * the HTTP layer answers with a 500 to request ONE redelivery (bounded below), because absorbing it
 * would burn the event id while the change it carries is still unapplied.
 */
import { LunoraPaymentError } from "./errors";
import { LOCAL_REFUND_CLAIM_TYPE, localRefundKey } from "./idempotency";
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

/**
 * Prefix for the companion claim that bounds an orphaned event to a single retry. Claimed in the same
 * dedupe store as real event ids, so the bound survives isolate restarts without a second store.
 */
const ORPHAN_RETRY_MARKER = "orphan-retry:";

/** Claim `type` recorded for an {@link ORPHAN_RETRY_MARKER} row — internal bookkeeping, not a provider delivery. */
const ORPHAN_RETRY_CLAIM_TYPE = "marker.orphan_retry";

const SUBSCRIPTION_ACTION_BY_TYPE: Partial<Record<WebhookActionType, SubscriptionAction>> = {
    "subscription.active": "activate",
    "subscription.canceled": "cancel",
    "subscription.past_due": "mark_past_due",
    "subscription.paused": "pause",
};

/** The larger of two same-currency amounts. */
const maxMoney = (a: Money, b: Money): Money => (compareMoney(a, b) > 0 ? a : b);

/**
 * States in which the money has not been captured yet. A refund that lands on one of them is
 * out-of-order delivery, not an illegal transition — see the `orphaned` branch in `applyPayment`.
 */
const PRE_CAPTURE_STATES: ReadonlySet<PaymentState> = new Set<PaymentState>(["authorized", "initiated"]);

/**
 * The refund `action` still has to contribute, once what the facade already recorded is taken out.
 *
 * `refundPayment` folds the refund it issued into the row immediately — that ledger is what stops a
 * retry from issuing it twice — and leaves a marker. This event is that same money coming back: an
 * ABSOLUTE provider restates a cumulative total, which resolves to `max(...)` and is idempotent on
 * its own; a DELTA provider's event would add it a second time, so consume the marker and zero the
 * amount, leaving the event to carry only its state transition.
 *
 * Test-and-consume, with the two primitives the claim store has: claiming reports whether a marker
 * was there, and releasing restores the unclaimed state either way — so a SECOND, genuinely separate
 * refund still counts. The marker is keyed on the provider's own refund id, which is what makes two
 * in-flight facade refunds of the SAME amount on one session distinguishable: each leaves its own
 * marker and each confirming event consumes only that one. The amount is the key only for a provider
 * that reports no refund id on either side, where the two would still collide.
 */
const withoutLocallyRecordedRefund = async (store: PaymentStore, action: WebhookAction, existing: PaymentSession | undefined): Promise<WebhookAction> => {
    if (!existing || !action.sessionId || !action.amount || action.amountKind === "absolute") {
        return action;
    }

    const key = localRefundKey(action.sessionId, action.refundId, action.amount);
    const unclaimed = await store.markEventProcessed(action.provider, key, LOCAL_REFUND_CLAIM_TYPE);

    await store.releaseEvent(action.provider, key);

    return unclaimed ? action : { ...action, amount: zeroMoney(action.amount.currency) };
};

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

    // `max` rather than `+` because an absolute total already includes every earlier refund. It does
    // NOT include a lost-dispute reversal, which is a `"delta"` this same field accumulated: a
    // dispute lost for 30 followed by a refund of 20 resolves to `max(20, 30) = 30`, understating the
    // 50 that actually left. Unreachable on Stripe — it refuses to refund a charge with a lost
    // dispute, so that order never happens, and the reverse (refund 20, then dispute 30) adds to 50
    // correctly. Kept as a `max` on purpose: the alternative over-counts every ordinary re-delivered
    // cumulative total, which is reachable. If Stripe ever allows a refund after a lost dispute, this
    // is the line that has to change.
    const prospective = action.amountKind === "absolute" ? maxMoney(action.amount, base.refundedAmount) : addMoney(base.refundedAmount, action.amount);

    if (compareMoney(prospective, base.capturedAmount) > 0) {
        return undefined;
    }

    return prospective;
};

/**
 * The refund transition `action` implies on `existing`: "partial" while the resulting refunded total
 * stays below the captured total, a full "refund" otherwise. `refundedTotalFor` resolves the
 * absolute-vs-delta semantics, so the partial/full decision and the stored amount always agree.
 */
const resolveRefundAction = (existing: PaymentSession | undefined, action: WebhookAction): PaymentAction => {
    if (!existing) {
        return "refund";
    }

    const prospective = refundedTotalFor(existing, action);

    return prospective && compareMoney(prospective, existing.capturedAmount) < 0 ? "partial_refund" : "refund";
};

const applyPayment = async (store: PaymentStore, action: WebhookAction, paymentAction: PaymentAction): Promise<ApplyResult> => {
    if (!action.sessionId) {
        return { applied: false, reason: "unhandled" };
    }

    const existing = await store.getPaymentSession(action.provider, action.sessionId);
    const fromState: PaymentState = existing?.state ?? "initiated";
    const now = Date.now();
    const currency = action.amount?.currency ?? existing?.amount.currency ?? "USD";

    const effective = paymentAction === "refund" ? await withoutLocallyRecordedRefund(store, action, existing) : action;

    const resolvedAction = paymentAction === "refund" ? resolveRefundAction(existing, effective) : paymentAction;

    const toState = nextPaymentState(fromState, resolvedAction);

    if (!toState) {
        // A refund cannot apply before the capture it refunds. Providers do not guarantee ordering
        // (Stripe explicitly does not), so that is out-of-order delivery, not an illegal event:
        // report it as `orphaned` so the claim is released and the provider's ONE bounded retry
        // applies it once the capture lands. Dropping it would burn the event id and lose the refund
        // permanently — leaving a refunded customer entitled.
        const outOfOrder = paymentAction === "refund" && PRE_CAPTURE_STATES.has(fromState);

        return { applied: false, reason: outOfOrder ? "orphaned" : "illegal_transition" };
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

    if ((resolvedAction === "partial_refund" || resolvedAction === "refund") && effective.amount) {
        const prospective = refundedTotalFor(base, effective);

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

/**
 * Pick the FSM action a webhook implies, given where the row already is.
 *
 * Two arrivals at `active` are not the same transition, and no adapter can tell them
 * apart — every provider (Stripe, Creem, Dodo) reports both a renewal and a resume as
 * the same `subscription.active` event, so the current state is what disambiguates:
 *
 * Already `active` means `renew` (a period roll, a legal self-loop). `paused` means
 * `resume`, the only edge out of `paused` back to `active` — mapping it to `activate`
 * (illegal from `paused`) rejected every resume as `illegal_transition`, so a customer
 * who resumed and paid stayed denied by `check`/`hasActivePrice` until somebody ran
 * `reconcile` by hand.
 */
const resolveSubscriptionAction = (from: SubscriptionState, targetState: SubscriptionState, type: WebhookActionType): SubscriptionAction | undefined => {
    if (targetState === "active") {
        if (from === "active") {
            return "renew";
        }

        if (from === "paused") {
            return "resume";
        }
    }

    return SUBSCRIPTION_ACTION_BY_TYPE[type];
};

const applySubscription = async (store: PaymentStore, action: WebhookAction): Promise<ApplyResult> => {
    if (!action.subscriptionId) {
        return { applied: false, reason: "unhandled" };
    }

    const existing = await store.getSubscription(action.provider, action.subscriptionId);
    const now = Date.now();

    // A pure metadata change (price / quantity / cancel-at-period-end) with no state transition.
    if (action.type === "subscription.updated") {
        // Out-of-order delivery: the row this event patches doesn't exist yet. Surface a distinct
        // reason so the caller releases the event claim and the provider retries after the create
        // event lands — dropping it as `unhandled` would burn the event id and lose the update.
        if (!existing) {
            return { applied: false, reason: "orphaned" };
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

    const subscriptionAction = resolveSubscriptionAction(existing.state, targetState, action.type);

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

    // A blank/whitespace event id must never reach the dedupe store: `markEventProcessed` would
    // claim the same key (e.g. `creem:""`) once and permanently, so every SUBSEQUENT event with a
    // missing id — from any adapter, present or future — would be misclassified "duplicate" and
    // dropped with no state change. Throwing here returns non-2xx, so the provider retries instead
    // of the webhook silently going dark.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `WebhookAction.eventId` is typed `string`, but an adapter reading a missing field defensively could still hand this an `undefined` at runtime
    if (!action.eventId?.trim()) {
        throw new LunoraPaymentError("WEBHOOK_EVENT_ID_MISSING", `webhook event id is missing or blank for provider "${action.provider}"`);
    }

    const fresh = await store.markEventProcessed(action.provider, action.eventId, action.type);

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

    if (result.reason === "orphaned") {
        // The row this event patches doesn't exist yet (out-of-order delivery). Release the claim so
        // the provider's retry re-processes it after the create event lands — otherwise the id is
        // burned and the update is lost.
        //
        // BOUNDED, because the row may never appear: a subscription created before the integration
        // existed, a store/tenant reset, or a completed-but-unpaid checkout whose
        // `customer.subscription.created` never arrives. Retrying such an event forever makes the
        // provider hammer the endpoint until it disables it (Stripe gives up after ~3 days), taking
        // every other event down with it. A companion marker in the same claim store records that the
        // event has already had its retry; the second sighting keeps the claim and acknowledges, so
        // the event stops rather than the endpoint. The observer sees `reason: "unhandled"` for it.
        const retryable = await store.markEventProcessed(action.provider, `${ORPHAN_RETRY_MARKER}${action.eventId}`, ORPHAN_RETRY_CLAIM_TYPE);

        if (retryable) {
            await store.releaseEvent(action.provider, action.eventId);
        } else {
            result = { applied: false, reason: "unhandled" };
        }
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
