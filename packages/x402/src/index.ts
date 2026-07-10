/**
 * `@lunora/x402` — agentic payments over the x402 protocol.
 *
 * Two rails, imported from subpaths so each tree-shakes independently:
 * - `@lunora/x402/charge` — a Lunora deployment charges agents per request.
 * - `@lunora/x402/pay` — a Lunora action/agent pays x402-gated resources.
 *
 * The root export carries only the shared, framework-level config/types.
 */
export type { X402Receipt, X402ReceiptSink } from "./charge/receipt";
export type { EvmAddress, FacilitatorConfig, X402CdpSignerConfig, X402ChargeConfig, X402PayConfig, X402Price, X402Recipient, X402SignerConfig } from "./config";
export { DEFAULT_FACILITATOR_URL, resolveFacilitatorUrl } from "./config";
export type { Caip2, FriendlyNetwork, X402Network } from "./networks";
export { EVM_NETWORKS, isEvmNetwork, isSvmNetwork, NETWORK_TO_CAIP2, SVM_NETWORKS, toCaip2 } from "./networks";
