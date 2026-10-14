import type { EventLogEntry } from "./event-log";

/**
 * Callback signature for state-change subscriptions.
 * @experimental
 */
type StateChangeCallback = (state: Readonly<Record<string, unknown>>) => void;

/**
 * Callback signature for event-type subscriptions.
 * @experimental
 */
type EventCallback = (entry: EventLogEntry) => void;

// ── Internal subscription records ──────────────────────────────────────

interface StateSub {
    callback: StateChangeCallback;
    id: string;
    kind: "state";
}

interface EventSub {
    callback: EventCallback;
    eventType: string;
    id: string;
    kind: "event";
}

type Subscription = StateSub | EventSub;

// ── SubscriptionManager ────────────────────────────────────────────────

/**
 * Manages subscriptions to state changes and individual event types
 * for the event-sourcing runtime.
 *
 * Each subscription returns an unsubscribe function — the caller is
 * expected to call it during cleanup (e.g. in a React `useEffect`
 * return or a Svelte `onDestroy`).
 * @example
 * ```ts
 * const subs = new SubscriptionManager();
 *
 * // Subscribe to every state change
 * const unsub1 = subs.onStateChange((state) => console.log("new state", state));
 *
 * // Subscribe to a specific event type
 * const unsub2 = subs.onEvent("user-created", (entry) => console.log("user created", entry.payload));
 *
 * // Later, when state or events arrive:
 * subs.notifyState({ users: [] });
 * subs.notifyEvent({ seq: 1, type: "user-created", payload: { id: "1" }, timestamp: 100 });
 *
 * // Cleanup
 * unsub1();
 * unsub2();
 * ```
 * @experimental
 */
class SubscriptionManager {
    readonly #subscriptions = new Map<string, Subscription>();
    #nextId = 0;

    // ── Registration ──────────────────────────────────────────────────

    /** Mint an id, store the subscription under it, and return its unsubscribe function. */
    #register(sub: Omit<EventSub, "id"> | Omit<StateSub, "id">): () => void {
        const id = String(this.#nextId);

        this.#nextId += 1;

        this.#subscriptions.set(id, { ...sub, id });

        return () => {
            this.#subscriptions.delete(id);
        };
    }

    /**
     * Subscribe to every state change emitted by the event source.
     * @returns Unsubscribe function.
     */
    public onStateChange(callback: StateChangeCallback): () => void {
        return this.#register({ kind: "state", callback });
    }

    /**
     * Subscribe to a specific event type.
     * @param eventType The event type to listen for (matches `entry.type`).
     * @param callback Invoked with each matching entry.
     * @returns Unsubscribe function.
     */
    public onEvent(eventType: string, callback: EventCallback): () => void {
        return this.#register({ kind: "event", eventType, callback });
    }

    // ── Notification ──────────────────────────────────────────────────

    /**
     * Notify all state-change subscribers with the current state.
     */
    public notifyState(state: Readonly<Record<string, unknown>>): void {
        for (const sub of this.#subscriptions.values()) {
            if (sub.kind === "state") {
                try {
                    sub.callback(state);
                } catch {
                    // Subscriber threw — keep notifying others.
                }
            }
        }
    }

    /**
     * Notify event-type subscribers whose `eventType` matches.
     */
    public notifyEvent(entry: EventLogEntry): void {
        for (const sub of this.#subscriptions.values()) {
            if (sub.kind === "event" && sub.eventType === entry.type) {
                try {
                    sub.callback(entry);
                } catch {
                    // Subscriber threw — keep notifying others.
                }
            }
        }
    }

    // ── Introspection ─────────────────────────────────────────────────

    /**
     * Return the total number of active subscriptions.
     */
    public get size(): number {
        return this.#subscriptions.size;
    }

    /**
     * Remove all subscriptions.
     */
    public clear(): void {
        this.#subscriptions.clear();
    }
}

export { SubscriptionManager };
export type { EventCallback, StateChangeCallback };
