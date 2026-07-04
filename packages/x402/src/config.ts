/**
 * Shared, framework-level config for `@lunora/x402` — the stable vocabulary both
 * rails agree on (networks, facilitator, price). The protocol-specific types
 * (payment requirements, signed payloads, settlement receipts) come from
 * `@x402/core` and are threaded in by the charge/pay modules, not redeclared
 * here.
 *
 * NOTE: do not `import "zod"` anywhere in this package. `@x402/core` pins zod@3
 * transitively while the repo pins zod@4 — two instances break `instanceof`.
 * Validate with `@lunora/values` (`v.*`) if you need runtime schema checks.
 */

/**
 * Networks x402 can settle on. EVM networks are served by `@x402/evm` (viem
 * signer); Solana by `@x402/svm` (a separate, non-viem signer). `base` /
 * `base-sepolia` are the primary prod / test pair.
 */
export type X402Network = "arbitrum" | "avalanche" | "base" | "base-sepolia" | "ethereum" | "optimism" | "polygon" | "solana" | "solana-devnet";

/** EVM networks (signed via `@x402/evm` + viem). */
export const EVM_NETWORKS = ["arbitrum", "avalanche", "base", "base-sepolia", "ethereum", "optimism", "polygon"] as const;

/** Solana networks (signed via `@x402/svm`). */
export const SVM_NETWORKS = ["solana", "solana-devnet"] as const;

/** True when `network` settles on an EVM chain (viem signer path). */
export const isEvmNetwork = (network: X402Network): boolean => (EVM_NETWORKS as ReadonlyArray<string>).includes(network);

/** True when `network` settles on Solana (`@x402/svm` signer path). */
export const isSvmNetwork = (network: X402Network): boolean => (SVM_NETWORKS as ReadonlyArray<string>).includes(network);

/**
 * The public, Coinbase-operated facilitator (verify + settle). It needs no API
 * key. Override with a self-hosted or CDP facilitator via {@link FacilitatorConfig}.
 */
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

/** How to reach a facilitator's `/verify` + `/settle` endpoints. */
export interface FacilitatorConfig {
    /** Extra headers for a private facilitator (e.g. a CDP bearer token). */
    readonly headers?: Record<string, string>;
    /** Base URL. Defaults to {@link DEFAULT_FACILITATOR_URL}. */
    readonly url?: string;
}

/**
 * A resource's price, as a USD-denominated decimal string (`"0.01"`, or the
 * `"$0.01"` shorthand) or a number of dollars (`0.01`). The scheme resolves it
 * to the network's stablecoin base units (USDC has 6 decimals) at challenge
 * time. (Kept `number | string` rather than a `` `$${string}` `` template
 * member — the template is subsumed by `string`, so it only adds noise.)
 */
export type X402Price = number | string;

/** An EVM recipient address (the merchant wallet that receives settlement). */
export type EvmAddress = `0x${string}`;

/** Recipient wallet the facilitator settles payments to, per network family. */
export interface X402Recipient {
    /** EVM payout address (required for EVM networks). */
    readonly evm?: EvmAddress;
    /** Solana payout address, base58 (required for SVM networks). */
    readonly svm?: string;
}

/**
 * Server-side (charge rail) config. The server needs only a **recipient
 * address** — no private key — because the facilitator performs settlement.
 */
export interface X402ChargeConfig {
    readonly facilitator?: FacilitatorConfig;
    /** Network this resource settles on. */
    readonly network: X402Network;
    /** Default price for a gated resource; per-resource overrides win. */
    readonly price: X402Price;
    /** Payout wallet(s). */
    readonly recipient: X402Recipient;
}

/**
 * Client-side (pay rail) config. The signer holds spending authority, so the
 * pay rail is ActionCtx-only and MUST be paired with a spend policy (Phase 5).
 */
export interface X402PayConfig {
    /** Network to transact on. Determines the signer family (EVM vs SVM). */
    readonly network: X402Network;
    /** How the agent wallet is custodied (raw key or CDP-managed). */
    readonly signer: X402SignerConfig;
}

/**
 * Wallet custody for the pay rail. Both are supported from day one. A
 * `"raw-key"` signer resolves a private key from `ctx.secrets` (viem for EVM,
 * an `@x402/svm` keypair for Solana) — simplest, self-custodied. A `"cdp"`
 * signer uses a Coinbase-managed wallet via `@coinbase/x402` (the optional peer).
 */
export type X402SignerConfig =
    | {
          /** Name of the `ctx.secrets` entry holding the private key. */
          readonly secretName: string;
          readonly type: "raw-key";
      }
    | {
          /** CDP account name / id. */
          readonly account: string;
          readonly type: "cdp";
      };

/** Resolve a facilitator's base URL, applying the public default. */
export const resolveFacilitatorUrl = (facilitator?: FacilitatorConfig): string => facilitator?.url ?? DEFAULT_FACILITATOR_URL;
