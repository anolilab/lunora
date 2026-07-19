/**
 * Service-worker infrastructure for `@lunora/client`.
 *
 * ## Modules
 *
 * - **ClientServiceWorker** — registration, lifecycle, and messaging.
 * - **message-bridge** — typed message protocol (ClientToSwMessage / SwToClientMessage).
 */

export type { ClientSwOptions, ServiceWorkerStatus } from "./client-sw";
export { ClientServiceWorker } from "./client-sw";
export type { ClientToSwMessage, SwToClientMessage } from "./message-bridge";
export { createReply, sendToSw } from "./message-bridge";
