/**
 * Service Worker runtime for Lunora tab-relay and liveness.
 *
 * ## What it does
 *
 * - **Install** — calls `self.skipWaiting()` so the new SW takes control immediately (no double-tab window).
 * - **Activate** — calls `self.clients.claim()` so all open tabs use this SW right away.
 * - **Message relay** — forwards `ClientToSwMessage` payloads to all other clients (tabs/workers), enabling cross-tab synchronisation without a SharedWorker.
 * - **Ping/pong** — responds to `ping` messages with `pong` for liveness checks (used by `@lunora/client`'s `ClientServiceWorker`).
 *
 * ## For bundlers / framework adapters
 *
 * This file is compiled separately from the main `@lunora/client` bundle and served as a static file. Place the compiled output where your framework serves static assets (e.g. `public/` in Vite, `public/` in Next.js) and register it:
 *
 * ```ts
 * const sw = new ClientServiceWorker({ swUrl: "/lunora-sw.js" });
 * ```
 * @module
 */

// ─── SW-scope types ────────────────────────────────────────────────────────
// The shared tsconfig uses lib:["DOM",…] which types `self` as Window.
// This file runs in ServiceWorkerGlobalScope (browser's SW context, not
// @cloudflare/workers-types).  The webworker lib provides the correct types;
// we must still cast `self` because the DOM lib shadows the global scope.

/// <reference lib="webworker" />

const swSelf = globalThis as unknown as ServiceWorkerGlobalScope;

// ─── Types ─────────────────────────────────────────────────────────────────

/** Shape of a client→SW message we understand. */
interface SwInboundMessage {
    correlationId?: string;
    payload?: unknown;
    type: string;
}

/** Shape of a SW→client reply. */
interface SwOutboundMessage {
    correlationId?: string;
    payload?: unknown;
    type: string;
}

// ─── Install ──────────────────────────────────────────────────────────────

/**
 * Skip the `waiting` lifecycle phase so the updated SW activates
 * immediately rather than waiting for all tabs to close.
 */
swSelf.addEventListener("install", (event: ExtendableEvent) => {
    event.waitUntil(swSelf.skipWaiting());
});

// ─── Activate ─────────────────────────────────────────────────────────────

/**
 * Claim all open clients so they start using this SW right away.
 * Without this, existing tabs would not be controlled until their next
 * navigation.
 */
swSelf.addEventListener("activate", (event: ExtendableEvent) => {
    event.waitUntil(swSelf.clients.claim());
});

// ─── Message relay ────────────────────────────────────────────────────────

/**
 * Handle messages from clients (tabs / other workers).
 *
 * Two message types are recognised:
 *
 * - **`ping`** — responds with `pong` + the same `correlationId`.
 * - **Everything else** — relayed to all other clients.
 */
swSelf.addEventListener("message", (event: ExtendableMessageEvent) => {
    const message = event.data as SwInboundMessage | undefined;

    if (!message || typeof message.type !== "string") {
        return;
    }

    const sourceClient = event.source as WindowClient | undefined;

    // ── Ping / Pong ──────────────────────────────────────────────────
    if (message.type === "ping") {
        const reply: SwOutboundMessage = {
            type: "pong",
            correlationId: message.correlationId,
        };

        if (sourceClient && typeof sourceClient.postMessage === "function") {
            sourceClient.postMessage(reply);
        }

        return;
    }

    // ── Relay to all other clients ───────────────────────────────────
    event.waitUntil(
        (async () => {
            const allClients = await swSelf.clients.matchAll({
                type: "window",
                includeUncontrolled: false,
            });

            for (const client of allClients) {
                // Do not echo back to the sender
                if (client === sourceClient) {
                    continue;
                }

                // Extra safety: compare IDs for when client references differ
                if (client.id === sourceClient?.id) {
                    continue;
                }

                client.postMessage(message);
            }
        })(),
    );
});
