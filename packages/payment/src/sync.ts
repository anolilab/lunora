/**
 * Apply a normalized {@link WebhookAction} to the {@link PaymentStore}.
 *
 * Flow: claim the event id (inbound idempotency) → map the action to an FSM transition → upsert
 * if legal, otherwise no-op. Duplicate and out-of-order webhooks are absorbed here, except an event
 * whose target row does not exist yet (an update before its create, a refund before its capture):
 * that reports `"orphaned"`, which the HTTP layer answers with a 500 for ONE bounded redelivery.
 */
import { LunoraPaymentError } from "./errors";
import { LOCAL_REFUND_CLAIM_TYPE, localRefundKey } from "./idempotency";
import { addMoney, compareMoney, maxMoney, zeroMoney } from "./money";
import type { PaymentObserver } from "./observability";
import { notifyObserver } from "./observability";
import type { PaymentAction, SubscriptionAction } from "./state-machine";
import { nextPaymentState, nextSubscriptionState } from "./state-machine";
import type { PaymentStore } from "./store";
import { ownerOf } from "./store";
import type { ApplyResult, Money, PaymentSession, PaymentState, Subscription, SubscriptionState, WebhookAction, WebhookActionType } from "./types";

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

/**
 * States in which the money has not been captured yet. A refund that lands on one of them is
 * out-of-order delivery, not an illegal transition — see the `orphaned` branch in `applyPayment`.
 */
const PRE_CAPTURE_STATES: ReadonlySet<PaymentState> = new Set<PaymentState>(["authorized", "initiated"]);

/** What {@link foldRefundOnce} resolved, plus the undo for the claim it minted. */
interface RefundFold {
    /**
     * Another writer already claimed this refund — a concurrent restatement, or the facade's own
     * `refundPayment`. Its write carries the money; this one must not write at all, because the row
     * it read predates that claim and upserting it would put the refunded total back.
     */
    readonly booked: boolean;

    /**
     * Undo the claim this fold minted. Call it on any path that does NOT write the refund into the
     * row, or the claim outlives the fold it stands for and the provider's retry books nothing.
     */
    readonly release: () => Promise<void>;
}

const noRelease = async (): Promise<void> => {};

const UNCLAIMED: RefundFold = { booked: false, release: noRelease };

/**
 * Book a DELTA provider's refund at most once, whoever reports it first.
 *
 * A delta event carries one refund's own amount, so the sync layer ADDS it — which is only correct
 * if each refund reaches this fold once. Two things break that.
 *
 * `refundPayment` folds the refund it issued into the row immediately (that ledger is what stops a
 * retry from issuing it twice) and leaves a marker; the confirming webhook is that same money coming
 * back.
 *
 * And a provider can report ONE refund under more than one event id. Polar maps both
 * `refund.created` and `refund.updated` to a refund event, so a refund that reaches `succeeded` and
 * is then touched again (a dispute attaching to it, say) restates the same money under a fresh event
 * id — which the `markEventProcessed` dedupe cannot catch, because the event ids genuinely differ.
 *
 * Both are the same shape, so one marker answers both: claim `local-refund:<session>:id:<refundId>`
 * and KEEP it. Whoever claims it first books the money, and every later restatement of that refund
 * id is `booked` and writes nothing — the refunded total is the whole of its state, so the winner's
 * write already carries the transition it implies. An ABSOLUTE provider (Stripe's
 * cumulative `amount_refunded`) resolves to `max(...)` and is idempotent without any of this, so it
 * is skipped.
 *
 * Without a provider refund id the key falls back to `(session, amount)`, which two genuinely
 * distinct same-amount refunds SHARE — keeping that claim would swallow the second one. So that case
 * keeps the old test-and-release behaviour: it still cancels the facade's own marker, and carries
 * the collision documented on `localRefundKey` rather than dropping real money.
 */
const foldRefundOnce = async (store: PaymentStore, action: WebhookAction, existing: PaymentSession | undefined): Promise<RefundFold> => {
    if (!existing || !action.sessionId || !action.amount || action.amountKind === "absolute") {
        return UNCLAIMED;
    }

    const key = localRefundKey(action.sessionId, action.refundId, action.amount);
    const unclaimed = await store.markEventProcessed(action.provider, key, LOCAL_REFUND_CLAIM_TYPE);

    if (action.refundId === undefined) {
        await store.releaseEvent(action.provider, key);

        return { booked: !unclaimed, release: noRelease };
    }

    if (!unclaimed) {
        return { booked: true, release: noRelease };
    }

    return {
        booked: false,
        release: async () => {
            await store.releaseEvent(action.provider, key);
        },
    };
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

/** The refunded total once `resolvedAction` applies, or `undefined` when its amount cannot be booked. */
const refundedAfter = (base: PaymentSession, action: WebhookAction, resolvedAction: PaymentAction): Money | undefined =>
    (resolvedAction === "partial_refund" || resolvedAction === "refund") && action.amount ? refundedTotalFor(base, action) : base.refundedAmount;

/**
 * A capture names the owner a subscription event may lack. Adopt it into an EXISTING blank row (the
 * subscription event landed first); the other order is resolved when `applySubscription` creates
 * the row from this session.
 */
const adoptOrphanSubscription = async (store: PaymentStore, action: WebhookAction, now: number): Promise<void> => {
    if (!action.subscriptionId || !action.referenceId) {
        return;
    }

    const subscription = await store.getSubscription(action.provider, action.subscriptionId);

    if (subscription && !subscription.referenceId.trim()) {
        await store.upsertSubscription({ ...subscription, referenceId: action.referenceId, updatedAt: now });
    }
};

/**
 * Fill what a stored session is missing — a blank owner, the subscription link — from any later
 * event, even one whose own transition is a no-op. Never moves an established owner.
 */
const adoptOrphanSession = async (
    store: PaymentStore,
    existing: PaymentSession | undefined,
    action: WebhookAction,
    now: number,
): Promise<PaymentSession | undefined> => {
    if (!existing) {
        return existing;
    }

    const referenceId = ownerOf(existing.referenceId, action.referenceId);
    const subscriptionId = existing.subscriptionId ?? action.subscriptionId;

    if (referenceId === existing.referenceId && subscriptionId === existing.subscriptionId) {
        return existing;
    }

    const adopted = { ...existing, referenceId, subscriptionId, updatedAt: now };

    await store.upsertPaymentSession(adopted);

    return adopted;
};

const applyPayment = async (store: PaymentStore, action: WebhookAction, paymentAction: PaymentAction): Promise<ApplyResult> => {
    if (!action.sessionId) {
        return { applied: false, reason: "unhandled" };
    }

    // No amount means no way to book it: resolving one as a FULL refund flipped the row to
    // `refunded` with nothing in `refundedAmount`, and the next `refundPayment` then issued the whole
    // captured amount again. Acknowledged (200) rather than orphaned — a retry carries no amount either.
    if (!action.amount && paymentAction === "refund") {
        return { applied: false, reason: "invalid_refund_amount" };
    }

    let existing = await store.getPaymentSession(action.provider, action.sessionId);
    const fromState: PaymentState = existing?.state ?? "initiated";
    const now = Date.now();

    // Before the FSM gate: ownership does not depend on whether this event's transition is legal.
    existing = await adoptOrphanSession(store, existing, action, now);
    await adoptOrphanSubscription(store, action, now);

    const currency = action.amount?.currency ?? existing?.amount.currency ?? "USD";

    const refund = paymentAction === "refund" ? await foldRefundOnce(store, action, existing) : undefined;

    if (refund?.booked) {
        return { applied: false, reason: "duplicate" };
    }

    const resolvedAction = paymentAction === "refund" ? resolveRefundAction(existing, action) : paymentAction;

    const toState = nextPaymentState(fromState, resolvedAction);

    if (!toState) {
        // A refund cannot apply before the capture it refunds. Providers do not guarantee ordering
        // (Stripe explicitly does not), so that is out-of-order delivery, not an illegal event:
        // report it as `orphaned` so the claim is released and the provider's ONE bounded retry
        // applies it once the capture lands. Dropping it would burn the event id and lose the refund
        // permanently — leaving a refunded customer entitled.
        const outOfOrder = paymentAction === "refund" && PRE_CAPTURE_STATES.has(fromState);

        // Nothing is written, so the claim must not stand: an `orphaned` refund is retried once and
        // has to book its money then, and an `illegal_transition` would leave a claim no event ever
        // consumes. Same reason on the two paths below.
        await refund?.release();

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
        subscriptionId: action.subscriptionId,
        updatedAt: now,
    };

    let { capturedAmount } = base;

    if (resolvedAction === "capture" && action.amount) {
        capturedAmount = action.amount;
    }

    const refundedAmount = refundedAfter(base, action, resolvedAction);

    if (!refundedAmount) {
        await refund?.release();

        return { applied: false, reason: "invalid_refund_amount" };
    }

    try {
        await store.upsertPaymentSession({
            ...base,
            capturedAmount,
            referenceId: ownerOf(base.referenceId, action.referenceId),
            refundedAmount,
            state: toState,
            updatedAt: now,
        });
    } catch (error) {
        // The claim is taken before the row, because a concurrent restatement of the same refund must
        // not double-count while this write is in flight. There is no transaction across the two, so a
        // failed write would otherwise leave the claim standing, and the provider's retry — which the
        // caller's rethrow triggers — would zero the amount and lose the refund entirely.
        await refund?.release();

        throw error;
    }

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

/** Overlay an event's fields on the stored row; an absent field leaves the stored value standing. */
const mergeSubscriptionEvent = (existing: Subscription, action: WebhookAction, now: number): Subscription => {
    return {
        ...existing,
        cancelAtPeriodEnd: action.cancelAtPeriodEnd ?? existing.cancelAtPeriodEnd,
        currentPeriodEnd: action.currentPeriodEnd ?? existing.currentPeriodEnd,
        currentPeriodStart: action.currentPeriodStart ?? existing.currentPeriodStart,
        lastEventAt: action.occurredAt ?? existing.lastEventAt,
        priceId: action.priceId ?? existing.priceId,
        // A reported set REPLACES the stored one (a plan change can remove an item); `undefined`
        // means "unknown", not "empty", so the stored set stands.
        priceIds: action.priceIds ?? existing.priceIds,
        quantity: action.quantity ?? existing.quantity,
        referenceId: ownerOf(existing.referenceId, action.referenceId),
        updatedAt: now,
    };
};

/** Subscription states that grant entitlements (mirrors `entitlements.ts`). */
const ENTITLING_STATES: ReadonlySet<SubscriptionState> = new Set<SubscriptionState>(["active", "trialing"]);

/**
 * Older than the last applied event, or the same instant and re-entitling. Stripe stamps whole
 * seconds and carries no sequence, so a tie cannot be ordered: other equal-time events still apply
 * in arrival order, but one that would re-entitle a non-entitled row fails closed — the next event
 * or a reconcile sweep restores provider truth.
 */
const isStaleSubscriptionEvent = (existing: Subscription, action: WebhookAction): boolean => {
    if (action.occurredAt === undefined || existing.lastEventAt === undefined) {
        return false;
    }

    if (action.occurredAt !== existing.lastEventAt) {
        return action.occurredAt < existing.lastEventAt;
    }

    const target = SUBSCRIPTION_STATE_BY_TYPE[action.type];

    return target !== undefined && ENTITLING_STATES.has(target) && !ENTITLING_STATES.has(existing.state);
};

const applySubscription = async (store: PaymentStore, action: WebhookAction): Promise<ApplyResult> => {
    if (!action.subscriptionId) {
        return { applied: false, reason: "unhandled" };
    }

    const existing = await store.getSubscription(action.provider, action.subscriptionId);
    const now = Date.now();

    // Providers redeliver after a 5xx, so an event can land after a newer one already applied — and
    // `past_due → active` is a legal edge, so a late `active` would re-entitle a customer whose
    // payment has since failed. Drop anything older than the last event applied to this row.
    if (existing && isStaleSubscriptionEvent(existing, action)) {
        // Its state is stale, but the owner it names still fills a blank row.
        const referenceId = ownerOf(existing.referenceId, action.referenceId);

        if (referenceId !== existing.referenceId) {
            await store.upsertSubscription({ ...existing, referenceId, updatedAt: now });
        }

        return { applied: false, reason: "stale" };
    }

    // A pure metadata change (price / quantity / cancel-at-period-end) with no state transition.
    if (action.type === "subscription.updated") {
        // Out-of-order delivery: the row this event patches doesn't exist yet. Surface a distinct
        // reason so the caller releases the event claim and the provider retries after the create
        // event lands — dropping it as `unhandled` would burn the event id and lose the update.
        if (!existing) {
            return { applied: false, reason: "orphaned" };
        }

        await store.upsertSubscription(mergeSubscriptionEvent(existing, action, now));

        return { applied: true, reason: "ok" };
    }

    const targetState = SUBSCRIPTION_STATE_BY_TYPE[action.type];

    if (!targetState) {
        return { applied: false, reason: "unhandled" };
    }

    if (!existing) {
        // No owner on the event: take the one the checkout's payment session recorded, if it landed first.
        const checkout = action.referenceId?.trim() ? undefined : await store.getPaymentSessionBySubscription(action.provider, action.subscriptionId);

        await store.upsertSubscription({
            cancelAtPeriodEnd: action.cancelAtPeriodEnd ?? false,
            createdAt: now,
            currentPeriodEnd: action.currentPeriodEnd,
            currentPeriodStart: action.currentPeriodStart ?? now,
            id: action.subscriptionId,
            lastEventAt: action.occurredAt,
            priceId: action.priceId ?? "",
            // Left ABSENT rather than defaulted to `[]`: an empty set would grant nothing, whereas
            // absent falls back to `[priceId]` on read — the right answer for the single-price
            // providers and for an adapter that could not establish the full set.
            priceIds: action.priceIds,
            provider: action.provider,
            quantity: action.quantity ?? 1,
            referenceId: ownerOf(action.referenceId, checkout?.referenceId),
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

    await store.upsertSubscription({ ...mergeSubscriptionEvent(existing, action, now), state: nextState });

    return { applied: true, reason: "ok" };
};

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
