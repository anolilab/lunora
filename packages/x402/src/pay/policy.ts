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
 * requirements down to the ones in an allowed asset, within the per-call cap for
 * that asset's decimals, and on the recipient / network allowlists — if nothing
 * survives, the client has no requirement to sign. The asset gate comes first
 * because the server chooses which token contract a payment transfers, so a USD cap
 * is only a bound once the asset it prices is pinned (see {@link AllowedAsset}).
 * `buildPaymentGuard` becomes a `BeforePaymentCreationHook` that runs on the one
 * selected requirement and enforces the stateful per-run cap and the async
 * confirmation gate before any signature — reserving the amount atomically as
 * soon as the cap check passes, so the reservation itself *is* the record (no
 * separate after-hook, and no check-then-act window between the check and the
 * debit). `releaseSpendOnFailure` becomes an `OnPaymentCreationFailureHook` that
 * frees a reservation if the signature itself later fails.
 */
/* eslint-disable import/exports-last -- the private asset-table / cap-scaling helpers read `usdToAtomic` and `DEFAULT_ALLOWED_ASSETS`, so they must sit below those exports; hoisting them above would trade this for no-use-before-define. Enforcement reads top-to-bottom, which matters more than export placement in money code. */
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

/** Lookup key for an allowed asset: its network plus its address, normalised per that network's casing rules. */
const assetKey = (asset: string, network: string): string => `${network}|${normaliseAddress(asset, network)}`;

/** A requirement's atomic base-unit amount: canonical digits only — no sign, no decimal point, no whitespace. */
const ATOMIC_AMOUNT = /^\d+$/;

/**
 * Parse a requirement's `amount`, or return `undefined` if it isn't a canonical atomic
 * quantity. The value is chosen by the *server*, so bare `BigInt` is the wrong tool
 * twice over: it throws on junk — an exception escaping the selection filter rather
 * than a fail-closed rejection — and it accepts `"-1"`, which slips under every cap
 * comparison. Callers refuse anything this can't parse.
 */
const parseAtomicAmount = (raw: string): bigint | undefined => (ATOMIC_AMOUNT.test(raw) ? BigInt(raw) : undefined);

/**
 * USDC uses 6 decimals, so a USD price converts to atomic base units at `10 ** 6`.
 * This is only the *default* for the standalone {@link usdToAtomic} helper —
 * a spend policy never assumes it, and scales each requirement by the decimals of
 * the asset it actually names (see {@link SpendPolicy.allowedAssets}).
 * @experimental
 */
export const DEFAULT_STABLECOIN_DECIMALS = 6;

/**
 * A stablecoin an agent wallet may pay in, and the decimals its atomic amounts are
 * denominated in.
 *
 * `decimals` is required and explicit: a 402 server names the token contract to
 * transfer, and the same atomic amount means a wildly different sum in a 6-decimal
 * versus an 18-decimal token. Assuming a decimal count is how a tiny USD cap comes
 * to authorise a large transfer, so the caller states it per asset. Note
 * `@x402/evm`'s own `DEFAULT_STABLECOINS` registry is *not* uniformly 6-decimal
 * (MegaUSD and Mezo USD are 18), which is exactly why it can't be trusted as a gate.
 * @experimental
 */
export interface AllowedAsset {
    /** Token contract (EVM) or mint (SVM) address. Matched case-insensitively on EVM, exactly on SVM. */
    readonly asset: string;
    /** Atomic base-unit decimals for this asset. Used to scale the USD caps — must match the token on chain. */
    readonly decimals: number;
    /** The network this asset lives on. Friendly names are resolved to CAIP-2. */
    readonly network: X402Network;
}

/**
 * The assets a policy allows when it doesn't name its own — the canonical
 * 6-decimal, dollar-pegged USDC on each network Lunora has a friendly alias for.
 *
 * Deliberately a small hand-mirrored table rather than `@x402/evm`'s
 * `DEFAULT_STABLECOINS`: that registry mixes 6- and 18-decimal assets, and importing
 * it would pull viem into every bundle that touches a policy (the scheme modules are
 * dynamically imported for exactly that reason — see `wallet.ts`). Addresses verified
 * against `@x402/evm` `DEFAULT_STABLECOINS` and `@x402/svm` `USDC_*_ADDRESS` at 2.19.0.
 *
 * `ethereum` (`eip155:1`) is absent — the SDK ships no default stablecoin for it, so
 * paying there needs an explicit {@link SpendPolicy.allowedAssets} entry.
 * @experimental
 */
export const DEFAULT_ALLOWED_ASSETS: ReadonlyArray<AllowedAsset> = [
    { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, network: "base" },
    { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, network: "base-sepolia" },
    { asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, network: "polygon" },
    { asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, network: "arbitrum" },
    { asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", decimals: 6, network: "arbitrum-sepolia" },
    { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, network: "solana" },
    { asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, network: "solana-devnet" },
];

/**
 * Spend limits and approval gates for an agent wallet. At least one bound must be
 * set — see {@link assertBoundedPolicy} — or the pay rail refuses to build.
 *
 * Caps are denominated in USD (the stablecoin's dollar value); addresses and
 * networks are matched against the requirement the server offers.
 * @experimental
 */
export interface SpendPolicy {
    /**
     * Asset allowlist, each entry carrying its own `decimals` (defaults to
     * {@link DEFAULT_ALLOWED_ASSETS} — canonical USDC per friendly network).
     *
     * This is a **security gate, not a convenience**: the server picks which token
     * contract gets transferred, so a policy that only caps a USD amount caps nothing
     * until the asset behind that amount is pinned. A requirement naming an asset
     * outside this list is refused, and the USD caps are scaled by the matched entry's
     * `decimals` — never by an assumed decimal count.
     *
     * Every entry must be dollar-pegged: the caps are USD, and the per-run ledger sums
     * atomic units across payments, so a non-$1 asset silently mis-prices both.
     */
    readonly allowedAssets?: ReadonlyArray<AllowedAsset>;
    /** Network allowlist. When set, only these networks may be paid on. */
    readonly allowedNetworks?: ReadonlyArray<X402Network>;
    /** Recipient allowlist. When set, only these `payTo` addresses may be paid. */
    readonly allowedRecipients?: ReadonlyArray<string>;

    /**
     * @deprecated One policy-wide decimal count can't describe the assets a server may
     * name, and guessing it is what let a small USD cap authorise a large transfer.
     * Setting this now throws — put the asset in {@link SpendPolicy.allowedAssets} with
     * its own `decimals` instead.
     */
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
 * Index a policy's allowed assets by `network|asset` for O(1) lookup during
 * selection, rejecting a policy that can't express a real gate. Both enforcement
 * paths build this from the same policy, so they can never disagree about which
 * assets are payable or how an amount scales.
 */
const buildAssetTable = (policy: SpendPolicy): Map<string, AllowedAsset> => {
    // eslint-disable-next-line sonarjs/deprecation -- reading the deprecated field is the point: it must be refused, not silently honoured.
    if (policy.decimals !== undefined) {
        throw new LunoraError(
            "BAD_REQUEST",
            "x402 policy: `decimals` is no longer supported — a single policy-wide decimal count can't describe the assets a server may name. List the asset in `allowedAssets` with its own `decimals` instead.",
        );
    }

    const assets = policy.allowedAssets ?? DEFAULT_ALLOWED_ASSETS;

    if (assets.length === 0) {
        throw new LunoraError(
            "BAD_REQUEST",
            "x402 policy: `allowedAssets` is empty, so no payment could ever be made. Omit it to accept the default USDC assets, or list at least one asset.",
        );
    }

    const table = new Map<string, AllowedAsset>();

    for (const asset of assets) {
        if (!Number.isInteger(asset.decimals) || asset.decimals < 0) {
            throw new LunoraError(
                "BAD_REQUEST",
                `x402 policy: allowedAssets[${asset.asset}].decimals must be a non-negative integer, got ${String(asset.decimals)}.`,
            );
        }

        const network = toCaip2(asset.network);
        const key = assetKey(asset.asset, network);
        const existing = table.get(key);

        // Last-wins on a conflicting duplicate would silently pick a precision — the
        // exact mis-pricing the asset gate exists to prevent. Two entries that merely
        // repeat the same decimals are harmless (easy to produce when allowlists are
        // concatenated), so only a genuine disagreement is refused.
        if (existing !== undefined && existing.decimals !== asset.decimals) {
            throw new LunoraError(
                "BAD_REQUEST",
                `x402 policy: allowedAssets lists ${asset.asset} on ${network} twice with different decimals (${String(existing.decimals)} and ${String(asset.decimals)}). One asset cannot have two precisions.`,
            );
        }

        table.set(key, { ...asset, network });
    }

    return table;
};

/**
 * Pre-scale a USD cap into atomic units once per distinct decimal count in `table`,
 * so enforcement is a map lookup rather than a conversion, and a malformed cap throws
 * at wallet-build time (as it did when a single decimals value was assumed) instead of
 * on the first payment.
 */
const scaleCapPerDecimals = (usd: X402Price | undefined, table: Map<string, AllowedAsset>): Map<number, bigint> => {
    const caps = new Map<number, bigint>();

    if (usd === undefined) {
        return caps;
    }

    for (const { decimals } of table.values()) {
        if (!caps.has(decimals)) {
            caps.set(decimals, usdToAtomic(usd, decimals));
        }
    }

    return caps;
};

/**
 * A `PaymentPolicy` that narrows the server's offered requirements to those a
 * bounded wallet may pay: in an allowed asset, within the per-call cap *for that
 * asset's decimals*, to an allowed recipient, on an allowed network. An empty result
 * means the client cannot pay — fail-closed.
 *
 * The asset check comes first and is what makes the amount check mean anything. The
 * server chooses the token contract the scheme will sign a transfer against, and
 * `amount` is in that token's atomic base units — so comparing it against a USD cap
 * converted at an assumed decimal count mis-prices any asset that doesn't match the
 * assumption. Pinning the asset (and taking its decimals from the policy, not the
 * requirement) closes that.
 * @experimental
 */
export const buildSpendPolicy = (policy: SpendPolicy): PaymentPolicy => {
    const assets = buildAssetTable(policy);
    const maxPerCall = scaleCapPerDecimals(policy.maxPerCall, assets);
    const allowedNetworks = policy.allowedNetworks?.map((network) => toCaip2(network));
    const { allowedRecipients } = policy;

    return (_version: number, requirements: PaymentRequirements[]): PaymentRequirements[] =>
        requirements.filter((requirement) => {
            const asset = assets.get(assetKey(requirement.asset, requirement.network));

            if (asset === undefined) {
                return false;
            }

            const amount = parseAtomicAmount(requirement.amount);

            if (amount === undefined) {
                return false;
            }

            const cap = maxPerCall.get(asset.decimals);

            if (cap !== undefined && amount > cap) {
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
 *
 * The asset is re-checked here rather than trusted from {@link buildSpendPolicy}:
 * the two are registered on separate client seams, and a guard that assumed the
 * filter ran would be one wiring change away from signing an unpinned asset.
 * @experimental
 */
export const buildPaymentGuard = (policy: SpendPolicy, state: SpendState): BeforePaymentCreationHook => {
    const assets = buildAssetTable(policy);
    const maxPerRun = scaleCapPerDecimals(policy.maxPerRun, assets);

    // `state` is a single atomic-unit total, so it only means something while every
    // payment in the run scales the same way. All allowed assets are dollar-pegged, so
    // uniform decimals is sufficient — USDC on Base and USDC on Solana sum correctly —
    // but a 6- and an 18-decimal asset in one run would not. Lock the run to the first
    // payment's decimals and refuse a mismatch (a per-asset ledger would lift this).
    let runDecimals: number | undefined;

    return async (context) => {
        const requirement = context.selectedRequirements;
        const asset = assets.get(assetKey(requirement.asset, requirement.network));

        if (asset === undefined) {
            return {
                abort: true,
                reason: `x402 policy: asset ${requirement.asset} on ${requirement.network} is not in this wallet's allowed assets, so its amount cannot be priced against the caps.`,
            };
        }

        if (runDecimals === undefined) {
            runDecimals = asset.decimals;
        } else if (runDecimals !== asset.decimals) {
            return {
                abort: true,
                reason: `x402 policy: this payment is in a ${String(asset.decimals)}-decimal asset but the run's spend is tracked in ${String(runDecimals)}-decimal units. One wallet cannot mix asset precisions under a single per-run cap.`,
            };
        }

        const amount = parseAtomicAmount(requirement.amount);

        if (amount === undefined) {
            return {
                abort: true,
                reason: `x402 policy: this payment's amount (${requirement.amount}) is not a canonical atomic quantity, so it cannot be checked against the caps.`,
            };
        }

        const cap = maxPerRun.get(asset.decimals);

        if (cap !== undefined && state.spentAtomic + amount > cap) {
            return {
                abort: true,
                reason: `x402 policy: this payment (${requirement.amount}) would exceed the per-run cap (already spent ${state.spentAtomic.toString()}, cap ${cap.toString()}, in atomic base units).`,
            };
        }

        // Reserve atomically (no `await` since the check above) so a concurrent
        // guard invocation for another in-flight payment sees this reservation.
        state.add(amount);

        // Only ONE of the release sites below can fire per invocation: the decline
        // branch RETURNS (it never reaches the catch), and only the throw branch
        // reaches the catch. `@x402/core` runs this before-hook OUTSIDE the `try`
        // that fires `onPaymentCreationFailure`, so a release here and a later
        // `releaseSpendOnFailure` never both run for the same amount. `SpendState.
        // release` clamps at 0 either way, so it stays fail-safe.
        try {
            if (policy.onPaymentRequired !== undefined) {
                // Exact `true`, never truthiness: this is a SPEND approval, and
                // the policy check below treats the mere presence of
                // `onPaymentRequired` as satisfying "bounded spend". A confirmation
                // hook returning its UI result object (`{ confirmed: false }`, a
                // dialog handle) would otherwise auto-approve every payment on a
                // wallet whose owner believes it is gated.
                const approved: unknown = await policy.onPaymentRequired(requirement);

                if (approved !== true) {
                    state.release(amount);

                    return { abort: true, reason: "x402 policy: payment was declined by onPaymentRequired." };
                }
            }

            return undefined;
        } catch (error) {
            // A throw from the confirmation gate (UI-prompt timeout, rejected
            // remote-approval fetch) must not leave the reservation held for the
            // rest of the run — release it and rethrow so the payment still aborts.
            state.release(amount);

            throw error;
        }
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
        // Server-controlled string — same fail-closed parse as the guard and the
        // selection filter. An unparsable amount releases nothing rather than
        // throwing out of a failure hook (which would mask the original error)
        // or, for a negative value, inflating the ledger.
        const amount = parseAtomicAmount(context.selectedRequirements.amount);

        if (amount !== undefined) {
            state.release(amount);
        }

        return Promise.resolve();
    };

/**
 * Guard at wallet-build time: refuse a policy with no bound whatsoever. Signing
 * money on an agent's behalf with unlimited spend authority is never the intent,
 * so this fails loudly rather than defaulting to unbounded.
 *
 * `allowedNetworks` / `allowedRecipients` / `allowedAssets` narrow *where* a payment
 * can go and *in what*, but none caps *how much* — a policy with only allowlists still
 * authorises unlimited spend to any recipient it permits. Only `maxPerCall`,
 * `maxPerRun`, or a dynamic `onPaymentRequired` gate actually bound spend, so only
 * those count here.
 * @experimental
 */
export const assertBoundedPolicy = (policy: SpendPolicy): void => {
    const bounded = policy.maxPerCall !== undefined || policy.maxPerRun !== undefined || policy.onPaymentRequired !== undefined;

    if (!bounded) {
        throw new LunoraError(
            "FORBIDDEN",
            "x402 pay: refusing to build a wallet with an unbounded spend policy. Set at least one of maxPerCall, maxPerRun, or onPaymentRequired (allowedNetworks/allowedRecipients/allowedAssets narrow but do not bound spend).",
        );
    }
};
