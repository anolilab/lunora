/**
 * The refund arithmetic of the payment row, in one place and without store access.
 *
 * A refund is counted in `PaymentSession.refundedAmount` and named in `PaymentSession.bookedRefunds` by the same
 * guarded write, so "is this refund counted" is a read of the row and "count it" is one conditional write. Every writer
 * (the webhook, `refundPayment`, the unbooked-refund settlement, reconcile) computes its write here.
 */
import { addMoney, compareMoney, maxMoney, zeroMoney } from "./money";
import type { BookedRefund, Money, PaymentSession } from "./types";

/** One refund a provider reports on its own, by its id. */
interface RefundDelta {
    readonly amount: Money;

    /**
     * The money has already moved, so a total past the capture is recorded as the capture rather than refused. Set by
     * `refundPayment`, which books what the provider just settled; a webhook delta past the capture is refused instead.
     */
    readonly capAtCapture?: boolean;
    readonly id: string;
    /** A lost dispute: also booked into `disputedAmount`, and capped at the capture when no larger than it. */
    readonly reversal?: "dispute";
}

type RefundDeltaOutcome =
    | { readonly bookedRefunds: ReadonlyArray<BookedRefund>; readonly disputedAmount?: Money; readonly kind: "booked"; readonly refundedAmount: Money }
    | { readonly kind: "duplicate" }
    | { readonly kind: "refused" };

/** A provider's cumulative refunded-to-date total, with the refunds it is made of when the provider named them. */
interface RefundTotal {
    /** As on {@link RefundDelta.capAtCapture}: a total past the capture is recorded as the capture. */
    readonly capAtCapture?: boolean;
    readonly refunds?: ReadonlyArray<{ readonly amount: Money; readonly refundId: string }>;
    readonly total: Money;
}

type RefundTotalOutcome =
    | { readonly bookedRefunds?: ReadonlyArray<BookedRefund>; readonly kind: "booked"; readonly refundedAmount: Money }
    | { readonly kind: "refused" }
    | { readonly kind: "unchanged" };

const DUPLICATE: RefundDeltaOutcome = { kind: "duplicate" };

const REFUSED: { readonly kind: "refused" } = { kind: "refused" };

// Never trimmed: an id dropped from the list lets a restatement of that refund count again.
const appendBooked = (listed: ReadonlyArray<BookedRefund> | undefined, added: ReadonlyArray<BookedRefund>): BookedRefund[] => [...(listed ?? []), ...added];

const sameCurrency = (row: PaymentSession, amount: Money): boolean =>
    row.refundedAmount.currency === amount.currency &&
    row.capturedAmount.currency === amount.currency &&
    (row.disputedAmount === undefined || row.disputedAmount.currency === amount.currency);

// A blank id never names a refund: every later blank id would be a duplicate of it.
const isBlankId = (id: string): boolean => id.trim() === "";

const minMoney = (a: Money, b: Money): Money => (compareMoney(a, b) < 0 ? a : b);

const disputedOf = (row: PaymentSession): Money => row.disputedAmount ?? zeroMoney(row.refundedAmount.currency);

const isRefundBooked = (row: Pick<PaymentSession, "bookedRefunds">, id: string): boolean => row.bookedRefunds?.some((refund) => refund.id === id) ?? false;

/**
 * Count one refund the provider reports by itself (a delta), at most once: a listed id answers `duplicate`. A currency
 * other than the row's is refused, and so is a total past the capture, except a lost dispute no larger than the capture
 * (the money is already gone, so it is capped rather than acknowledged and recorded nowhere) and a delta marked
 * {@link RefundDelta.capAtCapture}.
 */
const bookRefundDelta = (row: PaymentSession, delta: RefundDelta): RefundDeltaOutcome => {
    if (isBlankId(delta.id)) {
        return REFUSED;
    }

    if (isRefundBooked(row, delta.id)) {
        return DUPLICATE;
    }

    const { amount } = delta;

    if (!sameCurrency(row, amount)) {
        return REFUSED;
    }

    let refundedAmount = addMoney(row.refundedAmount, amount);

    if (compareMoney(refundedAmount, row.capturedAmount) > 0) {
        const capped = delta.capAtCapture === true || (delta.reversal === "dispute" && compareMoney(amount, row.capturedAmount) <= 0);

        if (!capped) {
            return REFUSED;
        }

        refundedAmount = row.capturedAmount;
    }

    return {
        bookedRefunds: appendBooked(row.bookedRefunds, [{ amount, id: delta.id, ...(delta.reversal === "dispute" ? { reversal: "dispute" as const } : {}) }]),
        // The dispute total is a part of the refunded total, so a capped dispute is capped there too.
        ...(delta.reversal === "dispute" ? { disputedAmount: minMoney(addMoney(disputedOf(row), amount), refundedAmount) } : {}),
        kind: "booked",
        refundedAmount,
    };
};

/**
 * Bring the row up to a provider's cumulative refund total. The total counts refunds only, while the row also holds
 * every lost dispute, so the disputes are added to it first; the row becomes the larger of the two (a stale or
 * redelivered total never moves it back), capped at the capture. A total that alone exceeds the capture, or is in
 * another currency, is refused. The refunds named with it are added to the list; `unchanged` only when neither the
 * total nor the list would move.
 */
const bookRefundTotal = (row: PaymentSession, input: RefundTotal): RefundTotalOutcome => {
    const { total } = input;

    if (!sameCurrency(row, total) || (input.capAtCapture !== true && compareMoney(total, row.capturedAmount) > 0)) {
        return REFUSED;
    }

    const reversed = maxMoney(addMoney(total, disputedOf(row)), row.refundedAmount);
    const refundedAmount = compareMoney(reversed, row.capturedAmount) > 0 ? row.capturedAmount : reversed;
    const added: BookedRefund[] = [];

    for (const refund of input.refunds ?? []) {
        if (!isBlankId(refund.refundId) && !isRefundBooked(row, refund.refundId) && !added.some((entry) => entry.id === refund.refundId)) {
            added.push({ amount: refund.amount, id: refund.refundId });
        }
    }

    if (compareMoney(refundedAmount, row.refundedAmount) <= 0 && added.length === 0) {
        return { kind: "unchanged" };
    }

    return { ...(added.length === 0 ? {} : { bookedRefunds: appendBooked(row.bookedRefunds, added) }), kind: "booked", refundedAmount };
};

/** The row fields a `booked` outcome sets, to spread over the row it was computed from. */
const bookedChanges = (
    outcome: Extract<RefundDeltaOutcome | RefundTotalOutcome, { kind: "booked" }>,
): Pick<PaymentSession, "bookedRefunds" | "disputedAmount" | "refundedAmount"> => {
    return {
        ...(outcome.bookedRefunds === undefined ? {} : { bookedRefunds: outcome.bookedRefunds }),
        ...("disputedAmount" in outcome && outcome.disputedAmount !== undefined ? { disputedAmount: outcome.disputedAmount } : {}),
        refundedAmount: outcome.refundedAmount,
    };
};

export { bookedChanges, bookRefundDelta, bookRefundTotal, isRefundBooked };
export type { RefundDelta, RefundDeltaOutcome, RefundTotal, RefundTotalOutcome };
