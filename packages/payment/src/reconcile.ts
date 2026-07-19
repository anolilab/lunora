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
 */
import type { PaymentAdapter } from "./adapter";
import { compareMoney } from "./money";
import type { PaymentObserver } from "./observability";
import { notifyObserver } from "./observability";
import type { PaymentStore } from "./store";
import type { PaymentSession, PaymentState, Subscription } from "./types";

/**
 * `ReconcileInput` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
interface ReconcileInput {
    readonly adapter: PaymentAdapter;
    /** Optional telemetry sink — fired per drifted row and once on completion. */
    readonly observability?: PaymentObserver;
    readonly paymentSessionIds?: ReadonlyArray<string>;
    readonly store: PaymentStore;
    readonly subscriptionIds?: ReadonlyArray<string>;
}

/**
 * `ReconcileResult` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
interface ReconcileResult {
    readonly checkedPayments: number;
    readonly checkedSubscriptions: number;
    readonly failedPayments: number;
    readonly failedSubscriptions: number;
    readonly updatedPayments: number;
    readonly updatedSubscriptions: number;
}

const sameCurrencyAmount = (a: PaymentSession["amount"], b: PaymentSession["amount"]): boolean => a.currency === b.currency && compareMoney(a, b) === 0;

const subscriptionDrifted = (existing: Subscription | undefined, current: Subscription): boolean =>
    existing?.state !== current.state ||
    existing.cancelAtPeriodEnd !== current.cancelAtPeriodEnd ||
    existing.currentPeriodEnd !== current.currentPeriodEnd ||
    existing.priceId !== current.priceId ||
    existing.quantity !== current.quantity;

const paymentDrifted = (existing: PaymentSession | undefined, current: PaymentSession): boolean =>
    existing?.state !== current.state ||
    !sameCurrencyAmount(existing.capturedAmount, current.capturedAmount) ||
    !sameCurrencyAmount(existing.refundedAmount, current.refundedAmount);

const REFUND_STATES: ReadonlySet<PaymentState> = new Set<PaymentState>(["partially_refunded", "refunded"]);

/**
 * Merge the provider's payment snapshot over the stored row without regressing owner attribution or a
 * refund the provider truth can't see. Reconcile trusts `getPaymentStatus` as authoritative, but some
 * providers surface neither refunds nor the reference on that call: a Stripe PaymentIntent stays
 * `succeeded` after a refund (refunds live on the charge the status call never fetches), and a Polar
 * order snapshot carries no `referenceId`. A naive overwrite would then erase a `charge.refunded`
 * webhook (re-entitling a refunded/charged-back customer) or blank a webhook-set reference (orphaning
 * the row from the `by_reference` index and the default authorizer). So never move the refunded total
 * backward, never regress a refund state back to `captured`, and never blank a non-empty reference.
 */
const mergePaymentTruth = (existing: PaymentSession | undefined, current: PaymentSession): PaymentSession => {
    if (!existing) {
        return current;
    }

    const sameRefundCurrency = existing.refundedAmount.currency === current.refundedAmount.currency;
    const refundedAmount =
        sameRefundCurrency && compareMoney(existing.refundedAmount, current.refundedAmount) > 0 ? existing.refundedAmount : current.refundedAmount;
    const state = current.state === "captured" && REFUND_STATES.has(existing.state) ? existing.state : current.state;
    const referenceId = current.referenceId === "" ? existing.referenceId : current.referenceId;

    return { ...current, referenceId, refundedAmount, state };
};

// Re-sync one subscription against the provider's truth. Returns whether the store changed.
const reconcileSubscription = async (adapter: PaymentAdapter, store: PaymentStore, id: string, observer?: PaymentObserver): Promise<boolean> => {
    const current = await adapter.getSubscriptionStatus(id);
    const existing = await store.getSubscription(adapter.identifier, id);

    if (!subscriptionDrifted(existing, current)) {
        return false;
    }

    // Preserve the original createdAt when we already had the row.
    await store.upsertSubscription({ ...current, createdAt: existing?.createdAt ?? current.createdAt });
    notifyObserver(observer, { id, kind: "subscription", provider: adapter.identifier, type: "reconcile.drift" });

    return true;
};

const reconcilePayment = async (adapter: PaymentAdapter, store: PaymentStore, id: string, observer?: PaymentObserver): Promise<boolean> => {
    const providerTruth = await adapter.getPaymentStatus(id);
    const existing = await store.getPaymentSession(adapter.identifier, id);
    const current = mergePaymentTruth(existing, providerTruth);

    if (!paymentDrifted(existing, current)) {
        return false;
    }

    await store.upsertPaymentSession({ ...current, createdAt: existing?.createdAt ?? current.createdAt });
    notifyObserver(observer, { id, kind: "payment", provider: adapter.identifier, type: "reconcile.drift" });

    return true;
};

interface SweepCounts {
    readonly failed: number;
    readonly updated: number;
}

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
    const settled = await Promise.allSettled(ids.map((id) => reconcileOne(id)));

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

/**
 * `reconcile` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
const reconcile = async (input: ReconcileInput): Promise<ReconcileResult> => {
    const { adapter, observability, store } = input;
    const subscriptionIds = input.subscriptionIds ?? [];
    const paymentSessionIds = input.paymentSessionIds ?? [];

    const subscriptionCounts = await sweep(
        subscriptionIds,
        "subscription",
        (id) => reconcileSubscription(adapter, store, id, observability),
        adapter,
        observability,
    );
    const paymentCounts = await sweep(paymentSessionIds, "payment", (id) => reconcilePayment(adapter, store, id, observability), adapter, observability);

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
        failedPayments: paymentCounts.failed,
        failedSubscriptions: subscriptionCounts.failed,
        updatedPayments: paymentCounts.updated,
        updatedSubscriptions: subscriptionCounts.updated,
    };
};

export { reconcile };
export type { ReconcileInput, ReconcileResult };
