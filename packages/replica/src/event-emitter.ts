/**
 * Type-safe event emitter that powers the event-sourcing runtime.
 * @example
 * ```ts
 * type MyEvents = { userCreated: { id: string; name: string }; error: { message: string } };
 *
 * const emitter = new EventEmitter<MyEvents>();
 * emitter.on("userCreated", (payload) => console.log(payload.name));
 * emitter.emit("userCreated", { id: "1", name: "alice" });
 * ```
 * @experimental
 */
export class EventEmitter<EventMap extends Record<string, unknown>> {
    readonly #listeners = new Map<keyof EventMap, Set<(payload: unknown) => void>>();
    readonly #wildcardListeners = new Set<(event: keyof EventMap, payload: unknown) => void>();

    // ── Registration ──────────────────────────────────────────────────

    /**
     * Register a handler for a specific event type.
     * @returns An unsubscribe function (equivalent to calling {@link off}).
     */
    public on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): () => void {
        let set = this.#listeners.get(event);

        if (!set) {
            set = new Set();
            this.#listeners.set(event, set);
        }

        set.add(handler as (payload: unknown) => void);

        return () => {
            this.off(event, handler);
        };
    }

    /**
     * Remove a previously registered handler.
     */
    public off<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
        this.#listeners.get(event)?.delete(handler as (payload: unknown) => void);
    }

    /**
     * Register a wildcard handler that fires for **every** event type.
     * @returns An unsubscribe function.
     */
    public onAny(handler: (event: keyof EventMap, payload: unknown) => void): () => void {
        this.#wildcardListeners.add(handler);

        return () => {
            this.#wildcardListeners.delete(handler);
        };
    }

    /**
     * Remove a wildcard handler.
     */
    public offAny(handler: (event: keyof EventMap, payload: unknown) => void): void {
        this.#wildcardListeners.delete(handler);
    }

    // ── Emission ──────────────────────────────────────────────────────

    /**
     * Emit an event. All registered handlers (typed + wildcard) are invoked
     * synchronously. Exceptions from handlers are caught and silently
     * swallowed — they **must not** break the emitter loop.
     * @returns `true` if at least one handler was called.
     */
    public emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): boolean {
        let called = false;

        // Typed listeners
        const typed = this.#listeners.get(event);

        if (typed) {
            for (const handler of typed) {
                try {
                    handler(payload);
                    called = true;
                } catch {
                    // Handler threw — keep the emitter loop alive.
                }
            }
        }

        // Wildcard listeners
        for (const handler of this.#wildcardListeners) {
            try {
                handler(event, payload);
                called = true;
            } catch {
                // Handler threw — keep the emitter loop alive.
            }
        }

        return called;
    }

    // ── Introspection ─────────────────────────────────────────────────

    /**
     * Return `true` when at least one listener is registered for `event`.
     */
    public hasListeners(event: keyof EventMap): boolean {
        return (this.#listeners.get(event)?.size ?? 0) > 0 || this.#wildcardListeners.size > 0;
    }

    /**
     * Return the number of typed listeners for a specific event.
     */
    public listenerCount(event: keyof EventMap): number {
        return this.#listeners.get(event)?.size ?? 0;
    }

    /**
     * Remove all listeners.
     */
    public clear(): void {
        this.#listeners.clear();
        this.#wildcardListeners.clear();
    }
}
