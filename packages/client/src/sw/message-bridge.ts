/**
 * Typed message protocol between the service worker and client tabs.
 *
 * The bridge uses `navigator.serviceWorker.controller.postMessage` for
 * client→SW and `self.clients.matchAll().then(c => c.postMessage)` for
 * SW→client. On the client side, the {@link ClientServiceWorker} relays
 * inbound messages to registered handlers.
 */

import type { ClientServiceWorker } from "./client-sw";

// ─── Message types ─────────────────────────────────────────────────────

/**
 * Outbound message from the client to the SW.
 */
export interface ClientToSwMessage {
    /** Opaque correlation ID for request/response patterns. */
    correlationId?: string;
    payload?: unknown;
    type: string;
}

/**
 * Inbound message from the SW to the client.
 */
export interface SwToClientMessage {
    /** Echoes the correlation ID from the client request, if any. */
    correlationId?: string;
    payload?: unknown;
    type: string;
}

// ─── Client-side helpers ───────────────────────────────────────────────

/**
 * Send a typed message to the service worker and optionally await a
 * matching response.
 * @returns A promise that resolves when the SW sends a reply with the
 * same `correlationId` (if `expectResponse` is true).
 */
export const sendToSw = (sw: ServiceWorker | null, message: ClientToSwMessage, expectResponse = false): Promise<unknown> =>
    new Promise((resolve, reject) => {
        if (!sw) {
            reject(new Error("No active service worker"));

            return;
        }

        const id = message.correlationId ?? crypto.randomUUID();

        const outgoingMessage: ClientToSwMessage = { ...message, correlationId: id };

        if (expectResponse) {
            // Timeout after 30s — declared before the handler so the success
            // path can clear it (otherwise it fires after resolution).
            let timer: ReturnType<typeof setTimeout>;

            const handler = (event: MessageEvent<SwToClientMessage>) => {
                if (event.data.correlationId === id) {
                    clearTimeout(timer);
                    navigator.serviceWorker.removeEventListener("message", handler);
                    resolve(event.data.payload);
                }
            };

            timer = setTimeout(() => {
                navigator.serviceWorker.removeEventListener("message", handler);
                reject(new Error(`SW message ${id} timed out`));
            }, 30_000);

            navigator.serviceWorker.addEventListener("message", handler);

            sw.postMessage(outgoingMessage);
        } else {
            sw.postMessage(outgoingMessage);
            resolve(undefined);
        }
    });

/**
 * Create a reply for a client message (call from inside the SW).
 */
export const createReply = (original: ClientToSwMessage, payload?: unknown): SwToClientMessage => {
    return {
        type: `${original.type}:reply`,
        payload,
        correlationId: original.correlationId,
    };
};
