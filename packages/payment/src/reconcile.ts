/**
 * Reconciliation sweep.
 *
 * Webhooks are eventually-but-not-guaranteed: an endpoint down past the provider's retry window
 * drops an event for good. A scheduled job re-fetches the provider's current truth for the given
 * ids and overwrites the store when it has drifted. Unlike webhook application, reconciliation
 * does **not** go through the FSM guard — the provider is authoritative here, so it repairs even
 * states a missed webhook left stale.
 *
 * The caller decides *which* ids to sweep (typically a `@lunora/scheduler` job querying the store
 * for non-terminal rows), keeping this function pure and testable.
 *
 * The same sweep also retries metered-usage forwards the provider never accepted (see
 * `sweepUnreportedUsage`) — the out-of-band retry `track`'s swallowed forward failure relies on.
 *
 * It does not clear a Polar/Dodo pending-refund hold: the store cannot list which sessions hold one, so
 * that repair is the per-session `settlePendingRefund` on the payment facade.
 */
import type { PaymentAdapter } from "./adapter";
import { usageForwardIsIdempotent } from "./idempotency";
import { addMoney, compareMoney, disputedAmountOf, maxMoney, zeroMoney } from "./money";
import type { PaymentObserver } from "./observability";
import { notifyObserver } from "./observability";
import { bookedChanges, bookRefundTotal, isRefundBooked } from "./refund-ledger";
import { REFUND_RANK, refundRungKept } from "./state-machine";
import type { PaymentStore } from "./store";
import { overlayProviderSubscription, ownerOf } from "./store";
import { storeSubscription } from "./subscription-policy";
import type { Customer, Money, PaymentSession, PaymentState, ProviderRefund, Subscription } from "./types";

interface ReconcileInput {
    readonly adapter: PaymentAdapter;
    /** Optional telemetry sink — fired per drifted row and once on completion. */
    readonly observability?: PaymentObserver;
    readonly paymentSessionIds?: ReadonlyArray<string>;

    /**
     * Refuse a second subscription that grants access on one reference. Required, so a sweep cannot re-grant access
     * the policy refused: pass the same value as `createPayment`'s `singleSubscriptionPerReference`.
     */
    readonly singleSubscriptionPerReference: boolean;
    readonly store: PaymentStore;
    readonly subscriptionIds?: ReadonlyArray<string>;

    /**
     * How many unreported usage events to retry forwarding upstream this sweep
     * (oldest first). Default {@link DEFAULT_USAGE_REPORT_LIMIT}; `0` skips the
     * usage sweep entirely. Ignored by an adapter that does not meter usage.
     */
    readonly usageReportLimit?: number;
}

interface ReconcileResult {
    readonly checkedPayments: number;
    readonly checkedSubscriptions: number;
    readonly checkedUsage: number;
    readonly failedPayments: number;
    readonly failedSubscriptions: number;
    /** Usage events whose retried forward failed again — still pending for the next sweep. */
    readonly failedUsage: number;
    readonly updatedPayments: number;
    readonly updatedSubscriptions: number;
    /** Usage events successfully forwarded upstream on this sweep. */
    readonly updatedUsage: number;
}

/** Usage events retried per sweep when the caller does not say otherwise. */
const DEFAULT_USAGE_REPORT_LIMIT = 100;

/**
 * Bounds on how long a failed usage forward waits before the sweep retries it. The wait is the
 * event's age, clamped: a fresh failure (a 5xx) is retried within minutes, and one that keeps
 * failing for days (a reference with no provider customer) settles at the cap, so it takes a
 * batch slot a few times a day rather than on every tick.
 */
const USAGE_RETRY_MIN_MS = 60_000;
const USAGE_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

const sameCurrencyAmount = (a: PaymentSession["amount"], b: PaymentSession["amount"]): boolean => a.currency === b.currency && compareMoney(a, b) === 0;

/**
 * The price SET is compared, not just the primary `priceId`: a removed add-on leaves the primary
 * standing, and without this a missed removal kept the add-on's entitlement forever. Only when the
 * provider reported a complete set — `undefined` is "unknown", the same rule `sync.ts` applies.
 */
const priceIdsDrifted = (existing: Subscription, current: Subscription): boolean => {
    if (current.priceIds === undefined) {
        return false;
    }

    const stored = new Set(existing.priceIds ?? [existing.priceId]);

    return stored.size !== new Set(current.priceIds).size || current.priceIds.some((id) => !stored.has(id));
};

const subscriptionDrifted = (existing: Subscription | undefined, current: Subscription): boolean =>
    existing?.state !== current.state ||
    existing.cancelAtPeriodEnd !== current.cancelAtPeriodEnd ||
    existing.currentPeriodEnd !== current.currentPeriodEnd ||
    existing.currentPeriodStart !== current.currentPeriodStart ||
    existing.priceId !== current.priceId ||
    priceIdsDrifted(existing, current) ||
    existing.quantity !== current.quantity;

const paymentDrifted = (existing: PaymentSession | undefined, current: PaymentSession): boolean =>
    existing?.state !== current.state ||
    !sameCurrencyAmount(existing.capturedAmount, current.capturedAmount) ||
    !sameCurrencyAmount(existing.refundedAmount, current.refundedAmount) ||
    (current.bookedRefunds?.some((refund) => !isRefundBooked(existing, refund.id)) ?? false);

/**
 * The money has already moved, so a refund total plus the stored disputes past the capture is
 * recorded as the capture, as the facade's write paths do: above it, every remainder goes negative.
 */
const capAtCapture = (total: Money, snapshot: PaymentSession): Money =>
    total.currency === snapshot.capturedAmount.currency && compareMoney(total, snapshot.capturedAmount) > 0 ? snapshot.capturedAmount : total;

/**
 * `state`, raised to the refund rung `refundedAmount` implies when that total is larger than the
 * snapshot's own: `refunded` once it reaches the captured amount, `partially_refunded` below that.
 * A state off the ladder is left alone.
 */
const refundStateAbove = (state: PaymentState, refundedAmount: Money, snapshot: PaymentSession): PaymentState => {
    const rank = REFUND_RANK[state];
    const { capturedAmount } = snapshot;

    if (
        rank === undefined ||
        refundedAmount.currency !== snapshot.refundedAmount.currency ||
        refundedAmount.currency !== capturedAmount.currency ||
        compareMoney(refundedAmount, snapshot.refundedAmount) <= 0
    ) {
        return state;
    }

    const implied: PaymentState = compareMoney(refundedAmount, capturedAmount) >= 0 ? "refunded" : "partially_refunded";

    return (REFUND_RANK[implied] ?? 0) > rank ? implied : state;
};

/**
 * Merge the provider's payment snapshot over the stored row without regressing owner attribution or a
 * refund the provider truth can't see. Reconcile trusts `getPaymentStatus` as authoritative, but some
 * providers surface neither refunds nor the reference on that call: a Stripe PaymentIntent stays
 * `succeeded` after a refund (refunds live on the charge the status call never fetches), and a Polar
 * order snapshot carries no `referenceId`. A naive overwrite would then erase a `charge.refunded`
 * webhook (re-entitling a refunded/charged-back customer) or blank a webhook-set reference (orphaning
 * the row from the `by_reference` index and the default authorizer). So never move the refunded total
 * backward, never regress a refund state, and never move a stored owner (see {@link ownerOf}).
 *
 * The state guard is a LADDER, not a single `captured` special case. A status read can report a
 * refund state that lags the row rather than only a pre-refund one: `orderToSession` (Polar) and
 * `checkoutToSession` (Creem) both map a `partially_refunded` status while filling `refundedAmount`
 * only for a fully `refunded` one — so a locally `refunded` row reconciles against
 * `{ state: "partially_refunded", refundedAmount: 0 }`. The total is `max`-ed and stays full while
 * the state slid back a rung, leaving a row whose refunded total equals its captured total under a
 * "partially refunded" label. `check` and every remainder calculation read that row, and
 * `partially_refunded` is not terminal where `refunded` is.
 *
 * A provider snapshot's refunded total counts refunds only, and no snapshot reports a lost dispute,
 * so the stored dispute total is added to it before the comparison and carried onto the result.
 * When that leaves the total above the snapshot's, the snapshot's state can sit a rung low on the
 * ladder for the same reason, so the state is raised to what the total implies.
 */
const mergePaymentTruth = (existing: PaymentSession | undefined, current: PaymentSession): PaymentSession => {
    if (!existing) {
        return current;
    }

    const { disputedAmount } = existing;
    const sameRefundCurrency =
        existing.refundedAmount.currency === current.refundedAmount.currency &&
        (disputedAmount === undefined || disputedAmount.currency === current.refundedAmount.currency);
    const reported =
        sameRefundCurrency && disputedAmount !== undefined ? capAtCapture(addMoney(current.refundedAmount, disputedAmount), current) : current.refundedAmount;
    const refundedAmount = sameRefundCurrency && compareMoney(existing.refundedAmount, reported) > 0 ? existing.refundedAmount : reported;
    const ladderState = refundRungKept(existing.state, current.state);

    // A snapshot names no refund, so the row's list is carried over as the dispute total is: written as the snapshot
    // has it, the list would be gone, and the next delta webhook for a listed refund would count it again.
    return {
        ...current,
        ...(existing.bookedRefunds === undefined ? {} : { bookedRefunds: existing.bookedRefunds }),
        ...(disputedAmount === undefined ? {} : { disputedAmount }),
        referenceId: ownerOf(existing.referenceId, current.referenceId),
        refundedAmount,
        state: refundStateAbove(ladderState, refundedAmount, current),
        subscriptionId: current.subscriptionId ?? existing.subscriptionId,
    };
};

/** `merged`, but never further along the refund ladder than `stored` (a state off the ladder counts as `captured`). */
const refundRungHeld = (stored: PaymentState, merged: PaymentState): PaymentState => {
    const mergedRank = REFUND_RANK[merged];

    if (mergedRank === undefined || mergedRank <= (REFUND_RANK[stored] ?? 0)) {
        return merged;
    }

    return REFUND_RANK[stored] === undefined ? "captured" : stored;
};

/**
 * Whether reconciling `stored` against `merged` raises the refunded total: a snapshot total that names no refund, which a
 * later delta webhook for one of its refunds would then count again unless the refunds are named with it.
 */
const raisesRefundedTotal = (stored: PaymentSession | undefined, merged: PaymentSession): stored is PaymentSession =>
    stored?.refundedAmount.currency === merged.refundedAmount.currency && compareMoney(merged.refundedAmount, stored.refundedAmount) > 0;

/**
 * The write for a snapshot that raises the refunded total, given the provider's refund list (`undefined` when it could
 * not be read). When the list's settled refunds, with the row's disputes, account for the raised total, total and ids
 * are booked together. Otherwise the snapshot is written with the stored refunded total and refund state, and the next
 * refund webhook or reconcile books the rest: raising the total without the ids is what let a delta webhook for a
 * refund the total already held count it a second time.
 */
const withListedRefunds = (
    stored: PaymentSession,
    merged: PaymentSession,
    snapshot: PaymentSession,
    refunds: ReadonlyArray<ProviderRefund> | undefined,
): PaymentSession => {
    const { currency } = stored.refundedAmount;
    const succeeded = (refunds ?? []).filter((refund) => refund.status === "succeeded" && refund.amount.currency === currency);
    let listed = zeroMoney(currency);

    for (const refund of succeeded) {
        listed = addMoney(listed, refund.amount);
    }

    const accounted = refunds !== undefined && compareMoney(capAtCapture(addMoney(listed, disputedAmountOf(stored)), merged), merged.refundedAmount) >= 0;
    // The list is read after the snapshot, so a refund that settled in between is listed but not in the snapshot's total:
    // naming it without its money would make its own webhook a duplicate, and the refund would be counted nowhere.
    const total = snapshot.refundedAmount.currency === currency ? maxMoney(snapshot.refundedAmount, listed) : listed;
    const outcome = accounted ? bookRefundTotal(stored, { refunds: succeeded, total }) : undefined;

    if (outcome?.kind === "booked") {
        return { ...merged, ...bookedChanges(outcome) };
    }

    return { ...merged, refundedAmount: stored.refundedAmount, state: refundRungHeld(stored.state, merged.state) };
};

// Amounts are bigints, which `JSON.stringify` refuses without a replacer.
const bigintAsString = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

/**
 * Whether a store row changed between two reads. The whole row is compared, not
 * `updatedAt`/`lastEventAt`: those are milliseconds (a write in the same one would
 * pass) and `lastEventAt` is optional, so a webhook could change a row and leave
 * both standing.
 */
const rowChanged = (before: unknown, after: unknown): boolean => JSON.stringify(after, bigintAsString) !== JSON.stringify(before, bigintAsString);

// Re-sync one subscription against the provider's truth. Returns whether the store changed.
//
// The row is read on both sides of the provider call: a webhook that lands while the adapter call
// is in flight is newer than the provider snapshot, and only a `before` read taken ahead of that
// call can see it change. The write is then guarded on the revision read at `after`, so a webhook
// that lands after that read makes the write a no-op rather than an overwrite.
const reconcileSubscription = async (
    adapter: PaymentAdapter,
    store: PaymentStore,
    id: string,
    observer: PaymentObserver | undefined,
    singleSubscriptionPerReference: boolean,
): Promise<boolean> => {
    const before = await store.getSubscription(adapter.identifier, id);
    const current = await adapter.getSubscriptionStatus(id);
    const after = await store.getSubscription(adapter.identifier, id);

    if (rowChanged(before, after)) {
        return false;
    }

    // The provider confirms the price as of now, so no event older than this read may replace it: stamped as a current
    // event stamps it. A row whose price a stale event filled (stamped before its `lastEventAt`) is stamped even when
    // nothing drifted; any other matching row is left unwritten.
    const confirmedAt = Date.now();

    if (!subscriptionDrifted(after, current)) {
        if (after?.priceEventAt !== undefined && after.priceEventAt < (after.lastEventAt ?? 0)) {
            await store.upsertSubscription({ ...after, priceEventAt: confirmedAt }, { ifRevision: after.revision });
        }

        return false;
    }

    // Provider truth for the lifecycle; the store keeps the owner (a read may not echo checkout
    // metadata, or report Dodo's customer id), `createdAt` and `lastEventAt`.
    const outcome = await storeSubscription(
        store,
        singleSubscriptionPerReference,
        after,
        { ...overlayProviderSubscription(after, current), priceEventAt: confirmedAt },
        { ifRevision: after?.revision },
    );

    // A refusal is still a write: the policy records the subscription in a state that grants nothing. It is counted and
    // reported as drift, so a sweep's totals and events show the row it changed.
    if (outcome === "rejected") {
        return false;
    }

    if (outcome === "refused") {
        notifyObserver(observer, { provider: adapter.identifier, subscriptionId: id, type: "subscription.duplicate" });
    }

    notifyObserver(observer, { id, kind: "subscription", provider: adapter.identifier, type: "reconcile.drift" });

    return true;
};

// Same before/after guard as `reconcileSubscription`. A refund list read after `after` is followed by another read, so the
// write stays guarded on a row read after every provider call.
const reconcilePayment = async (adapter: PaymentAdapter, store: PaymentStore, id: string, observer?: PaymentObserver): Promise<boolean> => {
    const before = await store.getPaymentSession(adapter.identifier, id);
    const providerTruth = await adapter.getPaymentStatus(id);
    const after = await store.getPaymentSession(adapter.identifier, id);

    if (rowChanged(before, after)) {
        return false;
    }

    let current = mergePaymentTruth(after, providerTruth);

    // Stripe and Creem list no refunds: Stripe sends no delta refund events, and a Creem delta past the capture is refused.
    if (adapter.listRefunds !== undefined && raisesRefundedTotal(after, current)) {
        const refunds = await adapter.listRefunds(id).catch(() => undefined);

        if (rowChanged(after, await store.getPaymentSession(adapter.identifier, id))) {
            return false;
        }

        current = withListedRefunds(after, current, providerTruth, refunds);
    }

    if (!paymentDrifted(after, current)) {
        return false;
    }

    const written = await store.upsertPaymentSession({ ...current, createdAt: after?.createdAt ?? current.createdAt }, { ifRevision: after?.revision });

    if (!written) {
        return false;
    }

    notifyObserver(observer, { id, kind: "payment", provider: adapter.identifier, type: "reconcile.drift" });

    return true;
};

/**
 * Retry the upstream forward for usage events that never reached the provider's
 * meter — `track` records the ledger row first and forwards after, so a transient
 * 5xx (or an adapter throw) leaves the row durable but the meter short. For a
 * provider that OWNS entitlements that unit is otherwise lost for good: the
 * customer is under-billed and over-entitled, and nothing else in the system ever
 * reads `reportedToProvider`.
 *
 * Only rows the store reports as still owing a forward are seen here — see
 * {@link PaymentStore.listUnreportedUsage}.
 *
 * Retrying is safe ONLY where the event's `idempotencyKey` reaches the provider's
 * ingestion body, because a row is unreported whether the request failed or merely
 * its response was lost, and nothing here can tell those apart. Stripe, Polar and
 * Dodo all carry the key, so the second case collapses to one debit. Autumn carries
 * nothing (`idempotency.ts`), so it would be a second debit — and the customer's
 * allowance is spent twice over. {@link usageForwardIsIdempotent} gates that out.
 */
const sweepUnreportedUsage = async (
    adapter: PaymentAdapter,
    store: PaymentStore,
    limit: number,
    observer?: PaymentObserver,
): Promise<SweepCounts & { checked: number }> => {
    const { reportUsage } = adapter;

    // `reportUsage` first: an adapter without it can't meter at all, and the check
    // is total even for a partial test double that omits `capabilities`.
    if (limit <= 0 || reportUsage === undefined || !adapter.capabilities.usageMetering || !usageForwardIsIdempotent(adapter.identifier)) {
        return { checked: 0, failed: 0, updated: 0 };
    }

    const now = Date.now();
    const pending = await store.listUnreportedUsage(adapter.identifier, limit, now);
    // Scoped to this tick: a batch often carries several events for one reference,
    // and each would repeat the same lookup. Only a found customer is memoised: a miss
    // (or a failed lookup, which throws before it is stored) is re-read by the next
    // event in this tick, so a customer created mid-tick is picked up.
    const customers = new Map<string, Customer>();
    let updated = 0;
    let failed = 0;

    for (const event of pending) {
        try {
            let customer = customers.get(event.referenceId);

            if (customer === undefined) {
                // eslint-disable-next-line no-await-in-loop -- a retry sweep against a provider that just failed: serial, not a stampede
                customer = await store.getCustomerByReference(adapter.identifier, event.referenceId);

                if (customer !== undefined) {
                    customers.set(event.referenceId, customer);
                }
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            await reportUsage({
                customerId: customer?.id,
                featureId: event.featureId,
                idempotencyKey: event.idempotencyKey,
                quantity: event.quantity,
                referenceId: event.referenceId,
            });
            // eslint-disable-next-line no-await-in-loop -- see above
            await store.markUsageReported(adapter.identifier, event.idempotencyKey);
            updated += 1;
        } catch {
            failed += 1;

            // From the failure, not the sweep's start: a slow batch would otherwise store a time already past.
            const failedAt = Date.now();
            const retryAt = failedAt + Math.min(Math.max(failedAt - event.createdAt, USAGE_RETRY_MIN_MS), USAGE_RETRY_MAX_MS);

            // A failed deferral only means the row stays due next tick, which is the old behaviour.
            // eslint-disable-next-line no-await-in-loop -- see above
            await store.deferUsageReport(adapter.identifier, event.idempotencyKey, retryAt).catch(() => {});
            notifyObserver(observer, {
                featureId: event.featureId,
                provider: adapter.identifier,
                referenceId: event.referenceId,
                type: "usage.report_failed",
            });
        }
    }

    return { checked: pending.length, failed, updated };
};

interface SweepCounts {
    readonly failed: number;
    readonly updated: number;
}

// ponytail: fixed guess under Stripe's rate limit; make it an option when a provider needs another value.
const RECONCILE_CONCURRENCY = 8;

// Fan out over a batch with per-id fault isolation: a single failing id (a 404'd/deleted row, a
// transient 5xx, a 429) must never abort the whole sweep, or drift for every other id would never
// self-heal. Each rejection is surfaced as a `reconcile.error` signal rather than thrown.
const sweep = async (
    ids: ReadonlyArray<string>,
    kind: "payment" | "subscription",
    reconcileOne: (id: string) => Promise<boolean>,
    adapter: PaymentAdapter,
    observer?: PaymentObserver,
): Promise<SweepCounts> => {
    // Bounded: one provider read per id, so an unbounded fan-out over a large batch trips the
    // provider's rate limit. Workers pull the next id off a shared cursor.
    const settled: PromiseSettledResult<boolean>[] = Array.from({ length: ids.length });
    let cursor = 0;
    const worker = async (): Promise<void> => {
        while (cursor < ids.length) {
            const index = cursor;

            cursor += 1;

            try {
                // eslint-disable-next-line no-await-in-loop -- each worker reconciles serially; the pool is the concurrency
                settled[index] = { status: "fulfilled", value: await reconcileOne(ids[index] ?? "") };
            } catch (error) {
                settled[index] = { reason: error, status: "rejected" };
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, ids.length) }, () => worker()));

    let updated = 0;
    let failed = 0;

    for (const [index, result] of settled.entries()) {
        if (result.status === "fulfilled") {
            if (result.value) {
                updated += 1;
            }
        } else {
            failed += 1;
            notifyObserver(observer, { error: result.reason, id: ids[index] ?? "", kind, provider: adapter.identifier, type: "reconcile.error" });
        }
    }

    return { failed, updated };
};

const reconcile = async (input: ReconcileInput): Promise<ReconcileResult> => {
    const { adapter, observability, store } = input;
    const subscriptionIds = input.subscriptionIds ?? [];
    const paymentSessionIds = input.paymentSessionIds ?? [];

    const subscriptionCounts = await sweep(
        subscriptionIds,
        "subscription",
        (id) => reconcileSubscription(adapter, store, id, observability, input.singleSubscriptionPerReference),
        adapter,
        observability,
    );
    const paymentCounts = await sweep(paymentSessionIds, "payment", (id) => reconcilePayment(adapter, store, id, observability), adapter, observability);
    const usageCounts = await sweepUnreportedUsage(adapter, store, input.usageReportLimit ?? DEFAULT_USAGE_REPORT_LIMIT, observability);

    // Always fire `reconcile.completed` (even when some ids failed) so the sweep is never a monitoring
    // blind spot, and report the failed counts alongside the updated ones.
    notifyObserver(observability, {
        failedPayments: paymentCounts.failed,
        failedSubscriptions: subscriptionCounts.failed,
        provider: adapter.identifier,
        type: "reconcile.completed",
        updatedPayments: paymentCounts.updated,
        updatedSubscriptions: subscriptionCounts.updated,
    });

    return {
        checkedPayments: paymentSessionIds.length,
        checkedSubscriptions: subscriptionIds.length,
        checkedUsage: usageCounts.checked,
        failedPayments: paymentCounts.failed,
        failedSubscriptions: subscriptionCounts.failed,
        failedUsage: usageCounts.failed,
        updatedPayments: paymentCounts.updated,
        updatedSubscriptions: subscriptionCounts.updated,
        updatedUsage: usageCounts.updated,
    };
};

export { reconcile };
export type { ReconcileInput, ReconcileResult };
