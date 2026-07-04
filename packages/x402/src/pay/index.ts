/**
 * `@lunora/x402/pay` — the pay rail (client side, ActionCtx-only).
 *
 * A Lunora action (or agent tool call) fetches an x402-gated resource: on the
 * `402` challenge it signs an `X-PAYMENT` payload with the agent wallet and
 * retries. Because the signer holds spending authority this rail is
 * **action-only** and MUST be paired with a spend policy (Phase 5:
 * per-call / per-window caps + confirmation, fail-closed).
 *
 * The wallet + fetch-wrapper machinery is filled in by Phase 4/5
 * (`wallet.ts` + `fetch.ts` + `policy.ts`). For now the subpath re-exports the
 * shared config so consumers can type their signer config against it.
 */
export type { X402Network, X402PayConfig, X402Price, X402SignerConfig } from "../config";
export { DEFAULT_FACILITATOR_URL, isEvmNetwork, isSvmNetwork, resolveFacilitatorUrl } from "../config";
