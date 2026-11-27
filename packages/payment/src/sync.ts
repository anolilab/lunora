/**
 * Apply a normalized {@link WebhookAction} to the {@link PaymentStore}.
 *
 * Flow: claim the event id (inbound idempotency) → map the action to an FSM transition → upsert
 * if legal, otherwise no-op. Duplicate and out-of-order webhooks are absorbed here, except an event
 * whose target row does not exist yet (an update before its create, a refund before its capture):
 * that reports `"orphaned"`, which the HTTP layer answers with a 500 for ONE bounded redelivery.
 */
import { LunoraPaymentError } from "./errors";
import { heldRefundIdOf, LOCAL_REFUND_CLAIM_TYPE, localRefundKey, pendingRefundHeldKey, pendingRefundKey, refundNeedsPendingGuard } from "./idempotency";
import { addMoney, compareMoney, disputedAmountOf, maxMoney, zeroMoney } from "./money";
import type { PaymentObserver } from "./observability";
import { notifyObserver } from "./observability";
import type { PaymentAction, SubscriptionAction } from "./state-machine";
import { nextPaymentState, nextSubscriptionState } from "./state-machine";
import type { PaymentStore, RevisionGuard } from "./store";
import { ownerOf } from "./store";
import { ENTITLING_STATES, storeSubscription, swapPrimaryPrice } from "./subscription-policy";
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

/** How often a payment event re-reads its row and recomputes after a concurrent write beat its guarded write. */
const SESSION_WRITE_ATTEMPTS = 3;

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
 * Settle the facade's pending-refund marker for the action's session. A hold that names its refund (the
 * provider answered `pending` with an id) is settled only by an event about that refund; one held without an
 * id, or a call still waiting on the provider, is settled by any refund event on the session.
 */
const releasePendingRefund = async (store: PaymentStore, action: WebhookAction): Promise<void> => {
    if (action.sessionId && refundNeedsPendingGuard(action.provider)) {
        const held = await store.getEventClaim(action.provider, pendingRefundHeldKey(action.sessionId));
        const heldRefundId = held === undefined ? undefined : heldRefundIdOf(held);

        if (heldRefundId !== undefined && action.refundId !== heldRefundId) {
            return;
        }

        // Only the claims read here: once the marker is released a newer call can claim and hold it, and the second
        // release must not take that call's hold with it.
        const pending = await store.getEventClaim(action.provider, pendingRefundKey(action.sessionId));

        if (pending !== undefined) {
            await store.releaseEvent(action.provider, pendingRefundKey(action.sessionId), pending);
        }

        if (held !== undefined) {
            await store.releaseEvent(action.provider, pendingRefundHeldKey(action.sessionId), held);
        }
    }
};

/** A failed refund moved no money, so the row stays as it is; it only lets a pending refund be retried. */
const applyRefundFailed = async (store: PaymentStore, action: WebhookAction): Promise<ApplyResult> => {
    if (!action.sessionId) {
        return { applied: false, reason: "unhandled" };
    }

    await releasePendingRefund(store, action);

    return { applied: true, reason: "ok" };
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

    // `max` rather than `+` because an absolute total already includes every earlier refund, so a
    // re-delivered or stale one adds nothing. It counts refunds only, though, while the stored total
    // also holds every lost dispute: the disputes are added back before the two are compared, or a
    // dispute of 30 then a refund total of 20 would resolve to 30 instead of 50.
    if (action.amountKind === "absolute") {
        if (compareMoney(action.amount, base.capturedAmount) > 0) {
            return undefined;
        }

        // A provider total within the capture is booked even when the stored disputes push the sum past
        // it, capped at the capture as `mergePaymentTruth` and `refundPayment` cap the same sum, rather
        // than refused, which would acknowledge the webhook and lose the refund.
        const total = maxMoney(addMoney(action.amount, disputedAmountOf(base)), base.refundedAmount);

        return compareMoney(total, base.capturedAmount) > 0 ? base.capturedAmount : total;
    }

    const prospective = addMoney(base.refundedAmount, action.amount);

    if (compareMoney(prospective, base.capturedAmount) > 0) {
        // A lost dispute has already taken the money back, so refusing it would acknowledge the webhook and
        // record it nowhere; it is capped at the capture as the absolute branch caps the same sum. An ordinary
        // refund past the capture is still refused, and so is a dispute that alone exceeds it.
        return action.reversal === "dispute" && compareMoney(action.amount, base.capturedAmount) <= 0 ? base.capturedAmount : undefined;
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

/** A lost dispute books its amount into the row's dispute total as well as the refunded total. */
const disputedAfter = (base: PaymentSession, action: WebhookAction, resolvedAction: PaymentAction): Pick<PaymentSession, "disputedAmount"> =>
    action.reversal === "dispute" && action.amount && (resolvedAction === "partial_refund" || resolvedAction === "refund")
        ? { disputedAmount: addMoney(disputedAmountOf(base), action.amount) }
        : {};

/**
 * A capture names the owner a subscription event may lack. Adopt it into an EXISTING blank row (the
 * subscription event landed first); the other order is resolved when `applySubscription` creates
 * the row from this session. Returns false when the policy refuses the adoption.
 */
const adoptOrphanSubscription = async (store: PaymentStore, action: WebhookAction, now: number, singleSubscriptionPerReference: boolean): Promise<boolean> => {
    if (!action.subscriptionId || !action.referenceId?.trim()) {
        return true;
    }

    const subscription = await store.getSubscription(action.provider, action.subscriptionId);

    if (!subscription || subscription.referenceId.trim()) {
        return true;
    }

    const adopted: Subscription = { ...subscription, referenceId: action.referenceId, updatedAt: now };

    return (await storeSubscription(store, singleSubscriptionPerReference, subscription, adopted)) !== "refused";
};

/**
 * Fill what a stored session is missing — a blank owner, the subscription link — from any later
 * event, even one whose own transition is a no-op. Never moves an established owner. Answers the row
 * as stored afterwards, or `undefined` when a concurrent write moved it since `existing` was read.
 */
const adoptOrphanSession = async (
    store: PaymentStore,
    existing: PaymentSession | undefined,
    action: WebhookAction,
    now: number,
): Promise<{ readonly session: PaymentSession | undefined } | undefined> => {
    if (!existing) {
        return { session: existing };
    }

    const referenceId = ownerOf(existing.referenceId, action.referenceId);
    const subscriptionId = existing.subscriptionId ?? action.subscriptionId;

    if (referenceId === existing.referenceId && subscriptionId === existing.subscriptionId) {
        return { session: existing };
    }

    // Guarded like the event's own write: an unguarded snapshot would undo a write that landed since the read.
    if (!(await store.upsertPaymentSession({ ...existing, referenceId, subscriptionId, updatedAt: now }, { ifRevision: existing.revision }))) {
        return undefined;
    }

    // Re-read rather than predict the revision the store gave this write: the event's own write is guarded on it.
    return { session: await store.getPaymentSession(action.provider, existing.id) };
};

/**
 * Write a payment session row, guarded on the revision it was derived from. `undefined` means a
 * concurrent write moved the row first: nothing was written, and the caller recomputes from a re-read.
 *
 * A value the store cannot hold (a money amount beyond 2^53 minor units) fails the same way on every
 * retry, so retrying only keeps the event undelivered. Nothing was written: that case answers
 * `unstorable` and gives the refund claim back, so the provider stops and the observer records the
 * reason. Any other failure rethrows, and `applyPayment` gives the claim back.
 */
const writeSession = async (
    store: PaymentStore,
    session: PaymentSession,
    guard: RevisionGuard,
    refund: RefundFold | undefined,
): Promise<ApplyResult | undefined> => {
    try {
        return (await store.upsertPaymentSession(session, guard)) ? { applied: true, reason: "ok" } : undefined;
    } catch (error) {
        if (error instanceof LunoraPaymentError && error.code === "VALIDATION_ERROR") {
            await refund?.release();

            return { applied: false, reason: "unstorable" };
        }

        throw error;
    }
};

/**
 * One pass of {@link applyPayment} over the row as read. `undefined` means a concurrent write beat this
 * pass's guarded write, and the caller re-reads; every other path returns its result.
 */
const applyPaymentTo = async (
    store: PaymentStore,
    action: WebhookAction & { readonly sessionId: string },
    paymentAction: PaymentAction,
    existing: PaymentSession | undefined,
    refund: RefundFold | undefined,
    now: number,
): Promise<ApplyResult | undefined> => {
    if (refund?.booked) {
        return { applied: false, reason: "duplicate" };
    }

    const fromState: PaymentState = existing?.state ?? "initiated";
    const currency = action.amount?.currency ?? existing?.amount.currency ?? "USD";
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

    const disputed = disputedAfter(base, action, resolvedAction);

    // `existing?.revision` is `undefined` for a missing row and for one written before the counter
    // existed; either guard still fails once another write lands, because every write bumps it.
    return writeSession(
        store,
        { ...base, capturedAmount, ...disputed, referenceId: ownerOf(base.referenceId, action.referenceId), refundedAmount, state: toState, updatedAt: now },
        { ifRevision: existing?.revision },
        refund,
    );
};

const applyPayment = async (
    store: PaymentStore,
    action: WebhookAction,
    paymentAction: PaymentAction,
    observer: PaymentObserver | undefined,
    singleSubscriptionPerReference: boolean,
): Promise<ApplyResult> => {
    const { sessionId } = action;

    if (!sessionId) {
        return { applied: false, reason: "unhandled" };
    }

    // No amount means no way to book it: resolving one as a FULL refund flipped the row to
    // `refunded` with nothing in `refundedAmount`, and the next `refundPayment` then issued the whole
    // captured amount again. Acknowledged (200) rather than orphaned — a retry carries no amount either.
    if (!action.amount && paymentAction === "refund") {
        return { applied: false, reason: "invalid_refund_amount" };
    }

    const now = Date.now();
    const adopted = await adoptOrphanSubscription(store, action, now, singleSubscriptionPerReference);

    if (!adopted) {
        // The capture still books. Only the owner is not adopted, and the operator is told which subscription to cancel.
        notifyObserver(observer, { provider: action.provider, subscriptionId: action.subscriptionId ?? "", type: "subscription.duplicate" });
    }

    // Taken once per event, not per pass: a pass that loses the row writes nothing, so the claim still
    // stands for the money this event carries, and claiming again would find it taken and answer
    // `duplicate`. A refund reaches a write only on an existing row, and rows are never removed, so a
    // pass that folded with no row ends without retrying.
    let refund: RefundFold | undefined;

    // The refund claim is taken before the row, because a concurrent restatement of the same refund must
    // not double-count while this event is in flight, and there is no transaction across the two. Any
    // exit without a write gives it back, a throw from a later pass included: the throw releases the
    // event claim too, and a redelivery that found this refund claimed would book nothing.
    try {
        for (let attempt = 0; attempt < SESSION_WRITE_ATTEMPTS; attempt += 1) {
            // Before the FSM gate: ownership does not depend on whether this event's transition is legal.
            // eslint-disable-next-line no-await-in-loop -- each pass re-reads the row the last one lost to
            const adoption = await adoptOrphanSession(store, await store.getPaymentSession(action.provider, sessionId), action, now);

            if (adoption === undefined) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- once per event, see `refund` above
            refund ??= paymentAction === "refund" ? await foldRefundOnce(store, action, adoption.session) : undefined;

            // eslint-disable-next-line no-await-in-loop -- see the read above
            const result = await applyPaymentTo(store, { ...action, sessionId }, paymentAction, adoption.session, refund, now);

            if (result !== undefined) {
                return result;
            }
        }

        // Never written unguarded: that would undo whatever beat it. The provider redelivers instead.
        throw new LunoraPaymentError(
            "INVALID_TRANSITION",
            `payment session "${sessionId}" kept changing while a webhook applied; the provider will redeliver it`,
        );
    } catch (error) {
        await refund?.release();

        throw error;
    }
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

/**
 * The price set after an event. A reported set REPLACES the stored one (a plan change can remove an item); `undefined`
 * means "unknown" (Stripe embeds only the first page of a longer item list), so the stored set stands — but with the
 * event's new primary price swapped in, or a plan change would keep granting the plan it left.
 */
const eventPriceIds = (existing: Subscription, action: WebhookAction): ReadonlyArray<string> | undefined => {
    if (action.priceIds !== undefined) {
        return action.priceIds;
    }

    return action.priceId !== undefined && action.priceId !== existing.priceId && existing.priceIds !== undefined
        ? swapPrimaryPrice(existing, action.priceId)
        : existing.priceIds;
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
        priceIds: eventPriceIds(existing, action),
        // A current event's price is authoritative: stamped with its time, which every stale event is older than,
        // so none may replace it. Stamped rather than cleared, because a store that patches leaves an absent field as it was.
        priceEventAt: action.priceId === undefined ? existing.priceEventAt : (action.occurredAt ?? now),
        quantity: action.quantity ?? existing.quantity,
        referenceId: ownerOf(existing.referenceId, action.referenceId),
        updatedAt: now,
    };
};

/** Subscription states that grant entitlements (mirrors `entitlements.ts`). */

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

/**
 * What a stale event may still contribute: the owner and the price a row was created without, never
 * its state or `lastEventAt`. A Stripe subscription-mode checkout creates the row with no price, and
 * the `customer.subscription.*` events that carry it are often stamped earlier, so without this the
 * row matches no plan until the next renewal. A priceless row's quantity and period start are
 * creation defaults, not provider data, so they come along with the price. A price a stale event
 * filled can be replaced by a NEWER stale event (`priceEventAt`): a subscription changed plan before
 * its checkout landed sends both events late, and the row must end on the second plan whatever order
 * they arrive in. Returns `existing` itself when there is nothing to fill.
 */
const fillBlankSubscription = (existing: Subscription, action: WebhookAction): Subscription => {
    const referenceId = ownerOf(existing.referenceId, action.referenceId);
    const refill = existing.priceEventAt !== undefined && action.occurredAt !== undefined && action.occurredAt > existing.priceEventAt;
    const priced = (existing.priceId === "" || refill) && Boolean(action.priceId);

    if (referenceId === existing.referenceId && !priced) {
        return existing;
    }

    if (!priced) {
        return { ...existing, referenceId };
    }

    return {
        ...existing,
        currentPeriodEnd: refill ? (action.currentPeriodEnd ?? existing.currentPeriodEnd) : (existing.currentPeriodEnd ?? action.currentPeriodEnd),
        currentPeriodStart: action.currentPeriodStart ?? existing.currentPeriodStart,
        priceEventAt: action.occurredAt,
        priceId: action.priceId ?? existing.priceId,
        priceIds: refill ? eventPriceIds(existing, action) : (existing.priceIds ?? action.priceIds),
        quantity: action.quantity ?? existing.quantity,
        referenceId,
    };
};

/** Create the row for a subscription the store has not seen: the checkout's owner, if it arrived first, and the opt-in duplicate check. */
const createSubscription = async (
    store: PaymentStore,
    action: WebhookAction,
    subscriptionId: string,
    targetState: SubscriptionState,
    singleSubscriptionPerReference: boolean,
    now: number,
): Promise<ApplyResult> => {
    // No owner on the event: take the one the checkout's payment session recorded, if it landed first.
    const checkout = action.referenceId?.trim() ? undefined : await store.getPaymentSessionBySubscription(action.provider, subscriptionId);
    const referenceId = ownerOf(action.referenceId, checkout?.referenceId);

    const created: Subscription = {
        cancelAtPeriodEnd: action.cancelAtPeriodEnd ?? false,
        createdAt: now,
        currentPeriodEnd: action.currentPeriodEnd,
        currentPeriodStart: action.currentPeriodStart ?? now,
        id: subscriptionId,
        lastEventAt: action.occurredAt,
        priceId: action.priceId ?? "",
        // Left ABSENT rather than defaulted to `[]`: an empty set would grant nothing, whereas
        // absent falls back to `[priceId]` on read — the right answer for the single-price
        // providers and for an adapter that could not establish the full set.
        priceIds: action.priceIds,
        provider: action.provider,
        quantity: action.quantity ?? 1,
        referenceId,
        state: targetState,
        updatedAt: now,
    };

    if ((await storeSubscription(store, singleSubscriptionPerReference, undefined, created)) === "refused") {
        return { applied: false, reason: "duplicate_subscription" };
    }

    return { applied: true, reason: "ok" };
};

/** Move a stored row through the event's transition, refused when it would start granting access against the policy. */
const transitionSubscription = async (
    store: PaymentStore,
    action: WebhookAction,
    existing: Subscription,
    targetState: SubscriptionState,
    singleSubscriptionPerReference: boolean,
    now: number,
): Promise<ApplyResult> => {
    const subscriptionAction = resolveSubscriptionAction(existing.state, targetState, action.type);

    const nextState = subscriptionAction ? nextSubscriptionState(existing.state, subscriptionAction) : undefined;

    if (!nextState) {
        return { applied: false, reason: "illegal_transition" };
    }

    const next: Subscription = { ...mergeSubscriptionEvent(existing, action, now), state: nextState };

    if ((await storeSubscription(store, singleSubscriptionPerReference, existing, next)) === "refused") {
        return { applied: false, reason: "duplicate_subscription" };
    }

    return { applied: true, reason: "ok" };
};

const applySubscription = async (store: PaymentStore, action: WebhookAction, singleSubscriptionPerReference: boolean): Promise<ApplyResult> => {
    if (!action.subscriptionId) {
        return { applied: false, reason: "unhandled" };
    }

    const existing = await store.getSubscription(action.provider, action.subscriptionId);
    const now = Date.now();

    // Providers redeliver after a 5xx, so an event can land after a newer one already applied — and
    // `past_due → active` is a legal edge, so a late `active` would re-entitle a customer whose
    // payment has since failed. Drop anything older than the last event applied to this row.
    if (existing && isStaleSubscriptionEvent(existing, action)) {
        const filled = fillBlankSubscription(existing, action);
        // Guarded on the revision read above: a newer event that landed since owns the state, and this whole-row write would
        // put the old one back. A rejected fill is dropped; the next event on the row can still fill it.
        const written =
            filled === existing
                ? undefined
                : await storeSubscription(store, singleSubscriptionPerReference, existing, { ...filled, updatedAt: now }, { ifRevision: existing.revision });

        if (written === "refused") {
            return { applied: false, reason: "duplicate_subscription" };
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

        if ((await storeSubscription(store, singleSubscriptionPerReference, existing, mergeSubscriptionEvent(existing, action, now))) === "refused") {
            return { applied: false, reason: "duplicate_subscription" };
        }

        return { applied: true, reason: "ok" };
    }

    const targetState = SUBSCRIPTION_STATE_BY_TYPE[action.type];

    if (!targetState) {
        return { applied: false, reason: "unhandled" };
    }

    if (!existing) {
        return createSubscription(store, action, action.subscriptionId, targetState, singleSubscriptionPerReference, now);
    }

    return transitionSubscription(store, action, existing, targetState, singleSubscriptionPerReference, now);
};

/** Route a claimed event to the row it changes. A throw here releases the claim, so the provider retries. */
const applyClaimedAction = async (
    store: PaymentStore,
    action: WebhookAction,
    observer: PaymentObserver | undefined,
    singleSubscriptionPerReference: boolean,
): Promise<ApplyResult> => {
    if (action.type === "payment.refund_failed") {
        return applyRefundFailed(store, action);
    }

    const paymentAction = PAYMENT_ACTION_BY_TYPE[action.type];

    if (!paymentAction) {
        return applySubscription(store, action, singleSubscriptionPerReference);
    }

    const result = await applyPayment(store, action, paymentAction, observer, singleSubscriptionPerReference);

    // Booked here, or already booked by another writer (`duplicate` from the fold): the refund settled.
    if (paymentAction === "refund" && (result.applied || result.reason === "duplicate")) {
        await releasePendingRefund(store, action);
    }

    return result;
};

const applyWebhookAction = async (
    store: PaymentStore,
    action: WebhookAction,
    observer?: PaymentObserver,
    singleSubscriptionPerReference = false,
): Promise<ApplyResult> => {
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

    let result: ApplyResult;

    try {
        result = await applyClaimedAction(store, action, observer, singleSubscriptionPerReference);
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

    // The provider still bills the refused subscription, so the operator has to cancel it there: this event is the alert.
    if (result.reason === "duplicate_subscription" && action.subscriptionId !== undefined) {
        notifyObserver(observer, { provider: action.provider, subscriptionId: action.subscriptionId, type: "subscription.duplicate" });
    }

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
