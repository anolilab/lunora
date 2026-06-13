/**
 * Reconciliation sweep.
 *
 * Webhooks are eventually-but-not-guaranteed: an endpoint down past the provider's retry window
 * drops an event for good. A scheduled job re-fetches the provider's current truth for the given
 * ids and overwrites the store when it has drifted. Unlike webhook application, reconciliation
 * does **not** go through the FSM guard — the provider is authoritative here, so it repairs even
 * states a missed webhook left stale.
 *
 * The caller decides *which* ids to sweep (typically a `@cirrus/scheduler` job querying the store
 * for non-terminal rows), keeping this function pure and testable.
 */
import type { PaymentAdapter } from "./adapter";
import { compareMoney } from "./money";
import type { PaymentStore } from "./store";
import type { PaymentSession, Subscription } from "./types";

interface ReconcileInput {
    readonly adapter: PaymentAdapter;
    readonly paymentSessionIds?: ReadonlyArray<string>;
    readonly store: PaymentStore;
    readonly subscriptionIds?: ReadonlyArray<string>;
}

interface ReconcileResult {
    readonly checkedPayments: number;
    readonly checkedSubscriptions: number;
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

// Re-sync one subscription against the provider's truth. Returns whether the store changed.
const reconcileSubscription = async (adapter: PaymentAdapter, store: PaymentStore, id: string): Promise<boolean> => {
    const current = await adapter.getSubscriptionStatus(id);
    const existing = await store.getSubscription(adapter.identifier, id);

    if (!subscriptionDrifted(existing, current)) {
        return false;
    }

    // Preserve the original createdAt when we already had the row.
    await store.upsertSubscription({ ...current, createdAt: existing?.createdAt ?? current.createdAt });

    return true;
};

const reconcilePayment = async (adapter: PaymentAdapter, store: PaymentStore, id: string): Promise<boolean> => {
    const current = await adapter.getPaymentStatus(id);
    const existing = await store.getPaymentSession(adapter.identifier, id);

    if (!paymentDrifted(existing, current)) {
        return false;
    }

    await store.upsertPaymentSession({ ...current, createdAt: existing?.createdAt ?? current.createdAt });

    return true;
};

const countTrue = (results: ReadonlyArray<boolean>): number => results.filter(Boolean).length;

const reconcile = async (input: ReconcileInput): Promise<ReconcileResult> => {
    const { adapter, store } = input;
    const subscriptionIds = input.subscriptionIds ?? [];
    const paymentSessionIds = input.paymentSessionIds ?? [];

    const subscriptionResults = await Promise.all(subscriptionIds.map((id) => reconcileSubscription(adapter, store, id)));
    const paymentResults = await Promise.all(paymentSessionIds.map((id) => reconcilePayment(adapter, store, id)));

    return {
        checkedPayments: paymentSessionIds.length,
        checkedSubscriptions: subscriptionIds.length,
        updatedPayments: countTrue(paymentResults),
        updatedSubscriptions: countTrue(subscriptionResults),
    };
};

export { reconcile };
export type { ReconcileInput, ReconcileResult };
