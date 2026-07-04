/**
 * `@lunora/x402/charge` — the charge rail (server side).
 *
 * A Lunora deployment gates a resource (an HTTP-action route, a procedure, or
 * an MCP tool) behind a USDC price: it returns `402 Payment Required` with a
 * `PAYMENT-REQUIRED` header, verifies the client's `X-PAYMENT` payload (via a
 * facilitator), runs the handler, settles, and attaches `X-PAYMENT-RESPONSE`.
 *
 * The verify/settle/challenge machinery is filled in by Phase 1 (`middleware.ts`
 * + `facilitator.ts`). For now the subpath re-exports the shared config so
 * consumers can type their `config.x402(env)` thunk against it.
 */
export type { EvmAddress, FacilitatorConfig, X402ChargeConfig, X402Price, X402Recipient } from "../config";
export { DEFAULT_FACILITATOR_URL, resolveFacilitatorUrl } from "../config";
export type { Caip2, X402Network } from "../networks";
export { isEvmNetwork, isSvmNetwork, toCaip2 } from "../networks";
