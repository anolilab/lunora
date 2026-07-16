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

import type { ClientEvmSigner } from "@x402/evm";
import type { ClientSvmSigner } from "@x402/svm";

import type { X402ReceiptSink } from "./charge/receipt";
import type { X402Network } from "./networks";
import type { SpendPolicy } from "./pay/policy";

/**
 * The public, Coinbase-operated facilitator (verify + settle). It needs no API
 * key. Override with a self-hosted or CDP facilitator via {@link FacilitatorConfig}.
 * @experimental
 */
export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

/**
 * How to reach a facilitator's `/verify` + `/settle` endpoints.
 * @experimental
 */
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
 * @experimental
 */
export type X402Price = number | string;

/**
 * An EVM recipient address (the merchant wallet that receives settlement).
 * @experimental
 */
export type EvmAddress = `0x${string}`;

/**
 * Recipient wallet the facilitator settles payments to, per network family.
 * @experimental
 */
export interface X402Recipient {
    /** EVM payout address (required for EVM networks). */
    readonly evm?: EvmAddress;
    /** Solana payout address, base58 (required for SVM networks). */
    readonly svm?: string;
}

/**
 * Server-side (charge rail) config. The server needs only a **recipient
 * address** — no private key — because the facilitator performs settlement.
 * @experimental
 */
export interface X402ChargeConfig {
    readonly facilitator?: FacilitatorConfig;
    /** Network this resource settles on. */
    readonly network: X402Network;

    /**
     * Opt-in, one-way telemetry sink fired once per settled payment. Best-effort:
     * it runs after settlement, never blocks the paid response, and its errors are
     * swallowed. Use it to mirror x402 revenue into a durable table / `@lunora/payment`'s
     * `events` table (see `toPaymentEventRow`) so it surfaces in Studio.
     */
    readonly onReceipt?: X402ReceiptSink;
    /** Default price for a gated resource; per-resource overrides win. */
    readonly price: X402Price;
    /** Payout wallet(s). */
    readonly recipient: X402Recipient;
}

/**
 * Client-side (pay rail) config. The signer holds spending authority, so the
 * pay rail is ActionCtx-only and MUST be paired with a spend `policy` — the pay
 * rail refuses to build if the policy is unbounded.
 * @experimental
 */
export interface X402PayConfig {
    /** Network to transact on. Determines the signer family (EVM vs SVM). */
    readonly network: X402Network;
    /** Mandatory spend limits + approval gates. An unbounded policy is refused. */
    readonly policy: SpendPolicy;
    /** How the agent wallet is custodied (raw key, a user-supplied signer, or CDP-managed). */
    readonly signer: X402SignerConfig;
}

/**
 * CDP-managed wallet custody via `@coinbase/cdp-sdk` (an optional peer). The SDK
 * gets-or-creates a named server account and signs the x402 EIP-712 payment
 * authorization with it — no private key ever leaves Coinbase. Needs three CDP
 * credentials, read from `ctx.secrets` under names that default to the SDK's own
 * env-var names; override them if your secrets are named differently. (Note
 * `@coinbase/x402` is a facilitator-auth helper, not a signer provider — CDP
 * custody is `@coinbase/cdp-sdk`.) EVM only today; for CDP on Solana, build a
 * `@solana/kit` signer around your CDP account and pass it via the `"signer"`
 * escape hatch.
 * @experimental
 */
export interface X402CdpSignerConfig {
    /** CDP account name to get-or-create and sign with. */
    readonly account: string;
    /** `ctx.secrets` name for the CDP API key id. Default `"CDP_API_KEY_ID"`. */
    readonly apiKeyIdSecretName?: string;
    /** `ctx.secrets` name for the CDP API key secret. Default `"CDP_API_KEY_SECRET"`. */
    readonly apiKeySecretName?: string;
    readonly type: "cdp";
    /** `ctx.secrets` name for the CDP wallet secret. Default `"CDP_WALLET_SECRET"`. */
    readonly walletSecretName?: string;
}

/**
 * Wallet custody for the pay rail — three shapes.
 *
 * `"raw-key"` resolves a private key from `ctx.secrets` (viem for EVM, a
 * `@solana/kit` keypair for Solana) — simplest, self-custodied.
 *
 * `"signer"` is the escape hatch: hand in a signer you already built — any
 * `@x402/evm` `ClientEvmSigner` (a viem account from Turnkey, Privy, an AWS/GCP
 * KMS `toAccount`, CDP's viem adapter, …) on an EVM network, or an `@x402/svm`
 * `ClientSvmSigner` (a `@solana/kit` `TransactionSigner`) on Solana. Adapt any
 * custody provider to the structural signer and pass it here; `@lunora/x402`
 * takes no dependency on the provider's SDK.
 *
 * `"cdp"` is a Coinbase-managed wallet via `@coinbase/cdp-sdk`
 * ({@link X402CdpSignerConfig}).
 *
 * Wired today: raw-key (EVM + SVM), the user-supplied signer (both families),
 * and CDP-managed EVM custody. CDP on Solana is not yet wired — use the escape
 * hatch.
 * @experimental
 */
export type X402SignerConfig =
    | X402CdpSignerConfig
    | {
          /** Name of the `ctx.secrets` entry holding the private key. */
          readonly secretName: string;
          readonly type: "raw-key";
      }
    | {
          /**
           * A pre-built signer you own: an EVM `ClientEvmSigner` (viem account) on
           * an EVM network, or an SVM `ClientSvmSigner` (`@solana/kit`
           * `TransactionSigner`) on Solana. Must match the config `network`'s family.
           */
          readonly signer: ClientEvmSigner | ClientSvmSigner;
          readonly type: "signer";
      };

/**
 * Resolve a facilitator's base URL, applying the public default.
 * @experimental
 */
export const resolveFacilitatorUrl = (facilitator?: FacilitatorConfig): string => facilitator?.url ?? DEFAULT_FACILITATOR_URL;
