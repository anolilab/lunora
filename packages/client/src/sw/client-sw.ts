/**
 * Client-side service-worker registration and lifecycle management.
 *
 * Usage:
 * ```ts
 * const sw = new ClientServiceWorker({ swUrl: "/sw.js" });
 * await sw.register();
 *
 * if (sw.active) {
 *   sw.postMessage({ type: "sync" });
 * }
 * ```
 */

export type ServiceWorkerStatus = "unsupported" | "unregistered" | "registering" | "active" | "error";

export interface ClientSwOptions {
    /** Called when the status changes. */
    onStatusChange?: (status: ServiceWorkerStatus) => void;
    /** Optional registration scope. Defaults to `/`. */
    scope?: string;
    /** URL of the service worker script (relative to origin). */
    swUrl: string;
}

/**
 * Manages service-worker registration and provides a simple API for
 * sending messages and listening for responses.
 */
export class ClientServiceWorker {
    public readonly swUrl: string;
    public readonly scope: string;

    #registration: ServiceWorkerRegistration | undefined = undefined;
    #status: ServiceWorkerStatus = "unregistered";
    #onStatusChange?: (status: ServiceWorkerStatus) => void;
    #messageHandlers = new Set<(event: MessageEvent) => void>();

    public constructor(options: ClientSwOptions) {
        this.swUrl = options.swUrl;
        this.scope = options.scope ?? "/";
        this.#onStatusChange = options.onStatusChange;
    }

    // ── Status ──────────────────────────────────────────────────────────

    /** Current registration status. */
    public get status(): ServiceWorkerStatus {
        return this.#status;
    }

    /** The underlying `ServiceWorkerRegistration`, if registered. */
    public get registration(): ServiceWorkerRegistration | undefined {
        return this.#registration;
    }

    /** Whether the SW is currently controlling this page. */
    public get active(): boolean {
        return this.#registration?.active !== null && this.#registration?.active !== undefined;
    }

    // ── Registration ────────────────────────────────────────────────────

    /**
     * Register the service worker.
     *
     * Returns `false` when the browser does not support service workers.
     */
    public async register(): Promise<boolean> {
        if (!("serviceWorker" in navigator)) {
            this.#setStatus("unsupported");

            return false;
        }

        this.#setStatus("registering");

        try {
            this.#registration = await navigator.serviceWorker.register(this.swUrl, {
                scope: this.scope,
            });

            this.#setStatus("active");

            // Listen for messages from the SW.
            navigator.serviceWorker.addEventListener("message", this.#onMessage);
        } catch {
            this.#setStatus("error");

            return false;
        }

        return true;
    }

    /**
     * Remove the active service worker registration and clear listeners.
     *
     * Returns `false` when no registration is currently held.
     */
    public async unregister(): Promise<boolean> {
        if (!this.#registration) {
            return false;
        }

        navigator.serviceWorker.removeEventListener("message", this.#onMessage);

        const ok = await this.#registration.unregister();

        this.#registration = undefined;
        this.#setStatus("unregistered");

        return ok;
    }

    // ── Messaging ───────────────────────────────────────────────────────

    /**
     * Send a message to the active service worker.
     */
    public postMessage(message: unknown): void {
        const active = this.#registration?.active;

        if (active) {
            active.postMessage(message);
        }
    }

    /**
     * Register a handler for messages **from** the service worker.
     * @returns Unsubscribe function.
     */
    public onMessage(handler: (event: MessageEvent) => void): () => void {
        this.#messageHandlers.add(handler);

        return () => {
            this.#messageHandlers.delete(handler);
        };
    }

    // ── Internals ───────────────────────────────────────────────────────

    #setStatus(status: ServiceWorkerStatus): void {
        this.#status = status;
        this.#onStatusChange?.(status);
    }

    #onMessage = (event: MessageEvent): void => {
        for (const handler of this.#messageHandlers) {
            try {
                handler(event);
            } catch {
                // Handler threw — keep notifying others.
            }
        }
    };
}
