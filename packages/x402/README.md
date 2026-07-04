# @lunora/x402

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

**Scaffold (Phase 0).** The package, subpaths, config vocabulary, and dependency
wiring are in place; the verify/settle/challenge machinery lands in later phases.
See `plans/134-x402-agentic-payments.md` for the roadmap.

## Networks & custody

- **EVM** (Base, Arbitrum, Ethereum, Polygon, …) is signed via [`@x402/evm`](https://npmjs.com/package/@x402/evm) + [viem](https://viem.sh); pass a raw CAIP-2 id for chains without a friendly alias.
- **Solana** is signed via [`@x402/svm`](https://npmjs.com/package/@x402/svm).
- **Facilitator** defaults to the public, Coinbase-operated `https://x402.org/facilitator` (no key required); override it for a self-hosted or CDP facilitator.
- **Pay-rail wallet custody** supports both a self-custodied raw key (from `ctx.secrets`) and a Coinbase-managed [CDP](https://docs.cdp.coinbase.com) wallet (via the optional `@coinbase/x402` peer).

## Safety

The **pay** rail spends real money autonomously. It is `ActionCtx`-only and,
once implemented, is fail-closed: every payment is bounded by a spend policy
(per-call and per-window caps) and may require confirmation. Never wire a signer
without a policy.

## License

FSL-1.1-Apache-2.0 © [Daniel Bannert](https://github.com/prisis)
