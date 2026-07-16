/**
 * Settlement receipts — the one-way, opt-in reporting seam for the charge rail.
 *
 * When a charge settles on-chain, the middleware normalises the facilitator's
 * settlement result into a stable {@link X402Receipt} and hands it to an optional
 * {@link X402ReceiptSink} (`config.onReceipt`). This is how x402 USDC revenue can
 * surface next to Stripe/Polar payments in Studio WITHOUT coupling the rails:
 * `@lunora/x402` never imports `@lunora/payment` and is not a `PaymentAdapter` —
 * the host decides where each receipt goes (a durable table, a log line, a
 * metrics counter). See {@link toPaymentEventRow} for a zero-import bridge to
 * `@lunora/payment`'s durable `events` table.
 *
 * The sink is best-effort telemetry: it runs only AFTER settlement succeeds, it
 * is not awaited into the paid response, and any error it throws is swallowed — a
 * reporting failure must never withhold a resource the client already paid for.
 */
import type { ProcessSettleSuccessResponse } from "@x402/core/http";

/**
 * A normalised record of one settled x402 payment. The settled `amount` is kept
 * as its exact on-chain atomic-unit string (USDC has 6 decimals) — never coerced
 * to a fractional-dollar number — so no precision is lost crossing the reporting
 * seam.
 * @experimental
 */
export interface X402Receipt {
    /** Settled amount in the asset's atomic base units (USDC: 6 decimals), as an exact string. */
    readonly amount: string;
    /** The settled asset's contract / mint address (e.g. Base USDC). */
    readonly asset: string;
    /** The payer's wallet address, when the facilitator reports it. */
    readonly from: string | undefined;
    /** The settlement network as a CAIP-2 id (e.g. `eip155:8453`). */
    readonly network: string;
    /** The gated resource this payment bought (a URL, or a procedure's `file:function` id). */
    readonly resource: string;
    /** The payout wallet the funds settled to (the merchant recipient). */
    readonly to: string;
    /** When the receipt was produced (epoch milliseconds). */
    readonly ts: number;
    /** On-chain settlement transaction id / hash. */
    readonly tx: string;
}

/**
 * A one-way, opt-in sink for settled-payment receipts. Wire it via
 * `config.onReceipt`. It is best-effort telemetry — the middleware fires it after
 * settlement, does not block the paid response on it, and swallows any error it
 * throws — so a sink must never rely on being awaited or on its failures
 * surfacing.
 * @experimental
 */
export type X402ReceiptSink = (receipt: X402Receipt) => Promise<void> | void;

/**
 * Normalise a successful facilitator settlement into an {@link X402Receipt}.
 * `resource` (the gated URL or procedure id) and `ts` are supplied by the caller —
 * the settlement result carries neither. Prefers the actual settled `amount`
 * (present for `upto`-scheme partial settlements) and falls back to the route's
 * required amount for `exact`.
 * @experimental
 */
export const toReceipt = (settlement: ProcessSettleSuccessResponse, context: { readonly resource: string; readonly ts: number }): X402Receipt => {
    return {
        amount: settlement.amount ?? settlement.requirements.amount,
        asset: settlement.requirements.asset,
        from: settlement.payer,
        network: settlement.network,
        resource: context.resource,
        to: settlement.requirements.payTo,
        ts: context.ts,
        tx: settlement.transaction,
    };
};

/**
 * A row for `@lunora/payment`'s durable `events` table. Deliberately a plain
 * structural type — building one imports nothing from `@lunora/payment`, so the
 * rails stay decoupled.
 * @experimental
 */
export interface PaymentEventRow {
    /** Epoch milliseconds the settlement was recorded. */
    readonly processedAt: number;
    /** The rail that produced the event. */
    readonly provider: "x402";
    /** The settlement tx hash — the natural unique event id (the table is unique on `(provider, providerEventId)`). */
    readonly providerEventId: string;
    /** The event kind, namespaced to the x402 rail. */
    readonly type: "x402.settled";
}

/**
 * Shape a receipt as a row for `@lunora/payment`'s durable `events` table, so a
 * settled x402 payment shows in Studio's Payments panel (its recent-events card)
 * with ZERO coupling: this returns a plain object matching that table's
 * documented column contract (`provider` / `providerEventId` / `type` /
 * `processedAt`, unique on `(provider, providerEventId)`) and imports nothing
 * from `@lunora/payment`. Insert it from a mutation ctx:
 *
 * ```ts
 * onReceipt: (receipt) => ctx.db.insert("events", toPaymentEventRow(receipt)),
 * ```
 *
 * The source of truth for the column contract is `@lunora/payment`'s `events`
 * table (`packages/payment/src/schema.ts`). Amount / from / to / resource are
 * intentionally not on this row — that card renders none of them; read them off
 * the {@link X402Receipt} (e.g. into your own revenue table) if you need them.
 * @experimental
 */
export const toPaymentEventRow = (receipt: X402Receipt): PaymentEventRow => {
    return {
        processedAt: receipt.ts,
        provider: "x402",
        providerEventId: receipt.tx,
        type: "x402.settled",
    };
};
