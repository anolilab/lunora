/**
 * The pay-rail spend policy — the security seam that keeps an autonomous agent
 * wallet from overspending.
 *
 * The pay rail signs real USDC transfers with no human in the loop, so it is
 * fail-closed by construction: `assertBoundedPolicy` refuses to build a wallet
 * whose policy has no bound at all, and every enforcement path blocks the payment
 * (returns an empty list, or aborts) rather than letting an unchecked one through.
 *
 * Enforcement maps onto `@x402/core`'s client seams. `buildSpendPolicy` becomes a
 * `PaymentPolicy` that runs at selection and filters the server's offered
 * requirements down to the ones within the per-call cap and on the recipient /
 * network allowlists — if nothing survives, the client has no requirement to sign.
 * `buildPaymentGuard` becomes a `BeforePaymentCreationHook` that runs on the one
 * selected requirement and enforces the stateful per-run cap and the async
 * confirmation gate before any signature — reserving the amount atomically as
 * soon as the cap check passes, so the reservation itself *is* the record (no
 * separate after-hook, and no check-then-act window between the check and the
 * debit). `releaseSpendOnFailure` becomes an `OnPaymentCreationFailureHook` that
 * frees a reservation if the signature itself later fails.
 */
import { LunoraError } from "@lunora/errors";
import type { BeforePaymentCreationHook, OnPaymentCreationFailureHook, PaymentPolicy } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";

import type { X402Price } from "../config";
import type { X402Network } from "../networks";
import { toCaip2 } from "../networks";

/** A plain USD decimal, optionally `$`-prefixed. Exponential notation is deliberately excluded. */
const USD_AMOUNT = /^\d+(?:\.\d+)?$/;

/** Normalise an address for comparison: EVM is case-insensitive, SVM (base58) is not. */
const normaliseAddress = (address: string, network: string): string => (network.startsWith("eip155:") ? address.toLowerCase() : address);

/**
 * USDC — and every asset in `@x402/evm` / `@x402/svm`'s `DEFAULT_STABLECOINS` —
 * uses 6 decimals, so a USD price converts to atomic base units at `10 ** 6`.
 * Override per {@link SpendPolicy.decimals} only for a custom, non-6-decimal asset.
 * @experimental
 */
export const DEFAULT_STABLECOIN_DECIMALS = 6;

/**
 * Spend limits and approval gates for an agent wallet. At least one bound must be
 * set — see {@link assertBoundedPolicy} — or the pay rail refuses to build.
 *
 * Caps are denominated in USD (the stablecoin's dollar value); addresses and
 * networks are matched against the requirement the server offers.
 * @experimental
 */
export interface SpendPolicy {
    /** Network allowlist. When set, only these networks may be paid on. */
    readonly allowedNetworks?: ReadonlyArray<X402Network>;
    /** Recipient allowlist. When set, only these `payTo` addresses may be paid. */
    readonly allowedRecipients?: ReadonlyArray<string>;
    /** Stablecoin decimals for USD→atomic conversion (default {@link DEFAULT_STABLECOIN_DECIMALS}). */
    readonly decimals?: number;
    /** Hard ceiling on a single payment, in USD. */
    readonly maxPerCall?: X402Price;
    /** Hard ceiling on cumulative spend across this wallet's lifetime, in USD. */
    readonly maxPerRun?: X402Price;

    /**
     * Approval gate. Called with the selected requirement before signing; return
     * `false` (or reject) to refuse the payment. Use for human-in-the-loop or any
     * dynamic rule the static caps can't express.
     */
    readonly onPaymentRequired?: (requirement: PaymentRequirements) => Promise<boolean> | boolean;
}

/**
 * A running spend ledger the per-run cap is measured (and reserved) against.
 * @experimental
 */
export interface SpendState {
    /** Reserve a payment (atomic base units) against the running total, before it is signed. */
    readonly add: (amount: bigint) => void;
    /** Release a previously reserved amount (atomic base units) — e.g. a declined or failed payment. Clamps at 0. */
    readonly release: (amount: bigint) => void;
    /** Cumulative spend so far, in atomic base units. */
    readonly spentAtomic: bigint;
}

/**
 * A fresh spend ledger. One per wallet instance; the guard reserves into it and
 * releases from it.
 * @experimental
 */
export const createSpendState = (): SpendState => {
    let spent = 0n;

    return {
        add: (amount: bigint): void => {
            spent += amount;
        },
        release: (amount: bigint): void => {
            spent = spent > amount ? spent - amount : 0n;
        },
        get spentAtomic(): bigint {
            return spent;
        },
    };
};

/**
 * Convert a USD amount (`0.01`, `"0.01"`, or the `"$0.01"` shorthand) to atomic
 * stablecoin base units, exactly — parsed digit-by-digit so no binary-float drift
 * can round a cap the wrong way. Throws on a malformed amount (including
 * exponential notation like `"1e-7"`, which a decimal string never needs).
 * @experimental
 */
export const usdToAtomic = (usd: X402Price, decimals: number = DEFAULT_STABLECOIN_DECIMALS): bigint => {
    if (!Number.isInteger(decimals) || decimals < 0) {
        throw new LunoraError("BAD_REQUEST", `x402 policy: decimals must be a non-negative integer, got ${String(decimals)}.`);
    }

    const raw = (typeof usd === "number" ? usd.toString() : usd).trim();
    const unsigned = raw.startsWith("$") ? raw.slice(1) : raw;

    if (!USD_AMOUNT.test(unsigned)) {
        throw new LunoraError("BAD_REQUEST", `x402 policy: "${String(usd)}" is not a valid USD amount (use a plain decimal like "0.01").`);
    }

    const [whole = "0", fraction = ""] = unsigned.split(".");
    const scaled = fraction.slice(0, decimals).padEnd(decimals, "0");

    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(scaled === "" ? "0" : scaled);
};

/**
 * A `PaymentPolicy` that narrows the server's offered requirements to those a
 * bounded wallet may pay: within the per-call cap, to an allowed recipient, on an
 * allowed network. An empty result means the client cannot pay — fail-closed.
 * @experimental
 */
export const buildSpendPolicy = (policy: SpendPolicy): PaymentPolicy => {
    const decimals = policy.decimals ?? DEFAULT_STABLECOIN_DECIMALS;
    const maxPerCall = policy.maxPerCall === undefined ? undefined : usdToAtomic(policy.maxPerCall, decimals);
    const allowedNetworks = policy.allowedNetworks?.map((network) => toCaip2(network));
    const { allowedRecipients } = policy;

    return (_version: number, requirements: PaymentRequirements[]): PaymentRequirements[] =>
        requirements.filter((requirement) => {
            if (maxPerCall !== undefined && BigInt(requirement.amount) > maxPerCall) {
                return false;
            }

            if (allowedNetworks !== undefined && !allowedNetworks.includes(requirement.network)) {
                return false;
            }

            if (allowedRecipients !== undefined) {
                const payTo = normaliseAddress(requirement.payTo, requirement.network);

                return allowedRecipients.some((allowed) => normaliseAddress(allowed, requirement.network) === payTo);
            }

            return true;
        });
};

/**
 * A `BeforePaymentCreationHook` enforcing the stateful bounds the stateless
 * {@link buildSpendPolicy} filter can't: the cumulative per-run cap and the async
 * confirmation gate. Aborts (no signature) when either would be violated.
 *
 * The per-run cap is *reserved* into `state` as soon as the check passes — before
 * the `await policy.onPaymentRequired` below, and before `@x402/core` ever attempts
 * to sign — not recorded afterwards. This closes a check-then-act race: without an
 * atomic reserve, N concurrent payments could each read the same `spentAtomic`,
 * all pass the cap check, and all record, overspending the cap by up to
 * (N−1)×maxPerCall. A declined confirmation releases the reservation before this
 * hook returns; {@link releaseSpendOnFailure} releases it if the signature itself
 * later fails. The reservation is intentionally *not* released on success — a
 * committed payment stays counted.
 * @experimental
 */
export const buildPaymentGuard = (policy: SpendPolicy, state: SpendState): BeforePaymentCreationHook => {
    const decimals = policy.decimals ?? DEFAULT_STABLECOIN_DECIMALS;
    const maxPerRun = policy.maxPerRun === undefined ? undefined : usdToAtomic(policy.maxPerRun, decimals);

    return async (context) => {
        const requirement = context.selectedRequirements;
        const amount = BigInt(requirement.amount);

        if (maxPerRun !== undefined && state.spentAtomic + amount > maxPerRun) {
            return {
                abort: true,
                reason: `x402 policy: this payment (${requirement.amount}) would exceed the per-run cap (already spent ${state.spentAtomic.toString()}, cap ${maxPerRun.toString()}, in atomic base units).`,
            };
        }

        // Reserve atomically (no `await` since the check above) so a concurrent
        // guard invocation for another in-flight payment sees this reservation.
        state.add(amount);

        if (policy.onPaymentRequired !== undefined) {
            const approved = await policy.onPaymentRequired(requirement);

            if (!approved) {
                state.release(amount);

                return { abort: true, reason: "x402 policy: payment was declined by onPaymentRequired." };
            }
        }

        return undefined;
    };
};

/**
 * An `OnPaymentCreationFailureHook` that releases a reservation
 * {@link buildPaymentGuard} made when the scheme's signature creation itself
 * throws (network error, wallet error, …) after the guard already approved and
 * reserved the amount. Without this, a failed signature would permanently
 * over-count against the per-run cap for the rest of the run — fail-closed, but
 * needlessly so when the client (`wrapFetchWithPayment`) may retry.
 * @experimental
 */
export const releaseSpendOnFailure =
    (state: SpendState): OnPaymentCreationFailureHook =>
    (context) => {
        state.release(BigInt(context.selectedRequirements.amount));

        return Promise.resolve();
    };

/**
 * Guard at wallet-build time: refuse a policy with no bound whatsoever. Signing
 * money on an agent's behalf with unlimited spend authority is never the intent,
 * so this fails loudly rather than defaulting to unbounded.
 *
 * `allowedNetworks` / `allowedRecipients` narrow *where* a payment can go, but
 * neither caps *how much* — a policy with only an allowlist still authorises
 * unlimited spend to any recipient it permits. Only `maxPerCall`, `maxPerRun`, or
 * a dynamic `onPaymentRequired` gate actually bound spend, so only those count here.
 * @experimental
 */
export const assertBoundedPolicy = (policy: SpendPolicy): void => {
    const bounded = policy.maxPerCall !== undefined || policy.maxPerRun !== undefined || policy.onPaymentRequired !== undefined;

    if (!bounded) {
        throw new LunoraError(
            "FORBIDDEN",
            "x402 pay: refusing to build a wallet with an unbounded spend policy. Set at least one of maxPerCall, maxPerRun, or onPaymentRequired (allowedNetworks/allowedRecipients narrow but do not bound spend).",
        );
    }
};
