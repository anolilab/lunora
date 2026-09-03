# @lunora/x402

> **Experimental** — this package is outside the Lunora 1.0 stability promise: its API may change in any release, without a major version bump.

> Agentic payments over the [x402](https://x402.org) protocol for [Lunora](https://lunora.sh).

x402 turns HTTP `402 Payment Required` into a machine-payable rail: no accounts,
no API keys, no webhooks — an agent pays per request in stablecoin (USDC) and a
third-party **facilitator** verifies and settles the payment on-chain.

`@lunora/x402` gives a Lunora app both sides of that exchange, as two
independently tree-shakeable subpaths:

| Subpath               | Rail       | Who uses it                                                                                        |
| --------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `@lunora/x402/charge` | **charge** | Your deployment **sells** — gate an HTTP-action route, a procedure, or an MCP tool behind a price. |
| `@lunora/x402/pay`    | **pay**    | Your action/agent **buys** — pay an x402-gated resource on the way out.                            |

The root export (`@lunora/x402`) carries only the shared config/types
(`X402Network`, `FacilitatorConfig`, price helpers).

## Status

**Both rails shipped.** The **charge** rail gates HTTP-action routes, procedures
(`.x402({ price })`), and MCP tools behind a USDC price; the **pay** rail signs and
retries `402` challenges under a mandatory spend policy.

## Install

The chain toolchains are **optional peers**, so an EVM-only deployment never
installs Solana's (heavy) toolchain and vice versa. Install the pair your
network family needs alongside the package:

```bash
pnpm add @lunora/x402                       # protocol core only
pnpm add @x402/evm viem                     # + EVM networks (Base, Arbitrum, …)
pnpm add @x402/svm @solana/kit              # + Solana networks
pnpm add @coinbase/cdp-sdk                  # + CDP-managed custody (EVM)
```

Missing a peer fails with an `ENV_INVALID` error naming exactly what to install.
Note that TypeScript needs the same peers present to resolve the pay rail's
signer types (`ClientSvmSigner` resolves through `@solana/kit`); with neither
family installed, compile the package's declarations under `skipLibCheck`.

## Networks & custody

- **EVM** (Base, Arbitrum, Ethereum, Polygon, …) is signed via [`@x402/evm`](https://npmjs.com/package/@x402/evm) + [viem](https://viem.sh); pass a raw CAIP-2 id for chains without a friendly alias.
- **Solana** is signed via [`@x402/svm`](https://npmjs.com/package/@x402/svm).
- **Facilitator** defaults to the public, Coinbase-operated `https://x402.org/facilitator` (no key required); override it for a self-hosted or CDP facilitator.

### Provider seams

Three parts of the exchange are pluggable, and each is chosen independently:

| Seam               | Default                                       | How to change it                                                                         |
| ------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Facilitator**    | public `https://x402.org/facilitator`         | `facilitator: { url, headers }` — self-hosted or a keyed CDP facilitator.                |
| **Wallet custody** | `"raw-key"` (a `ctx.secrets` key, EVM + SVM)  | `"cdp"` (Coinbase-managed, EVM) or the `"signer"` escape hatch (any provider you adapt). |
| **Scheme / chain** | exact scheme picked by `network` (EVM vs SVM) | choose the `network`; `@x402/evm` and `@x402/svm` register the matching exact scheme.    |

The pay rail's `signer` config selects wallet custody:

- **`{ type: "raw-key", secretName }`** — a self-custodied 32-byte key read from `ctx.secrets`. Works on **EVM and Solana**.
- **`{ type: "cdp", account }`** — a Coinbase-managed [CDP](https://docs.cdp.coinbase.com) server wallet via the optional [`@coinbase/cdp-sdk`](https://npmjs.com/package/@coinbase/cdp-sdk) peer. The SDK gets-or-creates the named account and signs the EIP-712 authorization, so the key never leaves Coinbase. Wired on **EVM**; the three CDP credentials are read from `ctx.secrets` (`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` / `CDP_WALLET_SECRET` by default, each overridable). CDP on Solana is not wired (a CDP Solana account is not a `@solana/kit` signer) — use the escape hatch.
- **`{ type: "signer", signer }`** — the **escape hatch**: hand in a signer you built yourself. Any custody provider (Turnkey, Privy, Fireblocks, an AWS/GCP KMS `toAccount`, CDP's viem adapter, …) works once adapted to the structural EVM (`ClientEvmSigner`) or Solana (`ClientSvmSigner`) shape — so `@lunora/x402` takes no dependency on any provider's SDK. No secret is read.

> `@coinbase/x402` is a **facilitator-auth** helper, not a custody provider; first-party Coinbase custody is `@coinbase/cdp-sdk`.

## Safety

The **pay** rail spends real money autonomously. It is `ActionCtx`-only and
fail-closed: every payment is bounded by a spend policy (`maxPerCall`, a ceiling
on a single payment, and `maxPerRun`, a ceiling on cumulative spend across the
wallet's lifetime — the ctx, for `ctx.x402`; there is no windowed cap) and may
require confirmation. The `policy` field is required, so you cannot
wire a signer without one; an unbounded policy is refused at runtime (fail-closed)
before any signer is resolved.

## License

FSL-1.1-Apache-2.0 © [Daniel Bannert](https://github.com/prisis)
