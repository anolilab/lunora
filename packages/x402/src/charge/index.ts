/**
 * `@lunora/x402/charge` — the charge rail (server side).
 *
 * A Lunora deployment gates a resource (an HTTP-action route, a procedure, or
 * an MCP tool) behind a USDC price: it returns `402 Payment Required` with a
 * `PAYMENT-REQUIRED` header, verifies the client's `X-PAYMENT` payload (via a
 * facilitator), runs the handler, settles, and attaches `X-PAYMENT-RESPONSE`.
 *
 * `withX402` gates a Lunora HTTP action; `createChargeMiddleware` is the
 * framework-agnostic core for other surfaces (procedures, MCP tools).
 */
export type { EvmAddress, FacilitatorConfig, X402ChargeConfig, X402Price, X402Recipient } from "../config";
export { DEFAULT_FACILITATOR_URL, resolveFacilitatorUrl } from "../config";
export { createFacilitatorClient } from "../facilitator";
export type { Caip2, X402Network } from "../networks";
export { isEvmNetwork, isSvmNetwork, toCaip2 } from "../networks";
export type { HttpActionHandler } from "./http-action";
export { withX402 } from "./http-action";
export type { ChargeHandler, ChargeHandlerDeps, ChargeMiddleware, ChargeMiddlewareOptions, ChargeRouteOverrides } from "./middleware";
export { createChargeMiddleware } from "./middleware";
export type { X402ProcedureChargeConfig, X402ProcedureChargeGate, X402ProcedureSpec } from "./procedure";
export { createProcedureChargeGate } from "./procedure";
export type { PaymentEventRow, X402Receipt, X402ReceiptSink } from "./receipt";
export { toPaymentEventRow, toReceipt } from "./receipt";
