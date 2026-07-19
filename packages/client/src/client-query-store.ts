import type { SubscriptionState } from "./subscription";

/**
 * Reactive key-value store for local-only client state.
 *
 * Unlike a server {@link SubscriptionState} (which tracks a live WS connection,
 * an `acked` flag, `serverBase`, optimistic layers, and the full subscription
 * machinery), a `ClientQueryRef` is purely local — no server round-trip, no
 * WebSocket, no persistence. It exists so framework adapters can offer a
 * `useClientQuery` hook whose values survive component remounts and are shared
 * across every consumer of the same ref, with none of the ceremony or coupling
 * of a dedicated context provider.
 *
 * The store lives inside `LunoraClient` (a private field) and is surfaced through
 * `client.getClientQuery(ref)` / `setClientQuery(ref, value)` /
 * `subscribeClientQuery(ref, callback)`.
 */

/** Opaque handle for a typed client-local query slot. */
interface ClientQueryRef<T = unknown> {
    /** Default value when no value has been set explicitly. */
    readonly defaultValue: T;
    /** Stable identity for the slot. Must be unique within a client instance. */
    readonly key: string;
}

/** A subscriber callback for value changes to a {@link ClientQueryRef}. */
type ClientQuerySubscriber = (value: unknown) => void;

/**
 * Internal store wiring — one instance per `LunoraClient`. Module-exported only
 * so `LunoraClient` can hold one; NOT part of the package's public API (not
 * re-exported from `index.ts`, held as a private field). Consumers interact
 * through `LunoraClient`'s public `getClientQuery` / `setClientQuery` /
 * `subscribeClientQuery` methods.
 */
class ClientQueryStore {
    /** Current values, keyed by the ref's stable key. Absent = never set. */
    private readonly values = new Map<string, unknown>();

    /** Subscribers keyed by ref key — notified on every set. */
    private readonly subscribers = new Map<string, Set<ClientQuerySubscriber>>();

    /**
     * Return the current value for `ref`, or `ref.defaultValue` if none has
     * been set explicitly. Returns `ref.defaultValue` when the slot has been
     * set to `undefined` (which is distinct from "never set").
     */
    public get<T>(ref: ClientQueryRef<T>): T {
        if (this.values.has(ref.key)) {
            return this.values.get(ref.key) as T;
        }

        return ref.defaultValue;
    }

    /**
     * Set a new value for `ref` and notify every subscriber. Pass `undefined`
     * to reset the slot to `ref.defaultValue` — delegates to {@link reset} so
     * `get` reports the default rather than a stored `undefined`.
     */
    public set<T>(ref: ClientQueryRef<T>, value: T): void {
        if (value === undefined) {
            this.reset(ref);

            return;
        }

        this.values.set(ref.key, value);
        this.notify(ref.key, value);
    }

    /**
     * Delete the stored value for `ref`, resetting to `ref.defaultValue` and
     * notifying subscribers.
     */
    public reset(ref: ClientQueryRef): void {
        this.values.delete(ref.key);
        this.notify(ref.key, ref.defaultValue);
    }

    /**
     * Subscribe to changes for `ref`. The callback is NOT invoked on
     * registration — callers should read the current value via
     * {@link get} first. Returns an unsubscribe function.
     */
    public subscribe(ref: ClientQueryRef, callback: ClientQuerySubscriber): () => void {
        let subs = this.subscribers.get(ref.key);

        if (!subs) {
            subs = new Set();
            this.subscribers.set(ref.key, subs);
        }

        subs.add(callback);

        return () => {
            subs.delete(callback);

            if (subs.size === 0) {
                this.subscribers.delete(ref.key);
            }
        };
    }

    /**
     * Notify every subscriber of a value change for the given key with the
     * resolved value — the caller passes the just-stored value on `set` or
     * `ref.defaultValue` on `reset`, so a subscriber always sees the same value
     * {@link get} would return (never a stale re-read after the store mutation).
     */
    private notify(key: string, value: unknown): void {
        const subs = this.subscribers.get(key);

        if (!subs) {
            return;
        }

        for (const callback of subs) {
            try {
                callback(value);
            } catch {
                /* subscriber threw — swallow so one bad listener can't starve others */
            }
        }
    }
}

/**
 * Create a typed {@link ClientQueryRef}. Call once per slot at module scope
 * (or inside a component module) — the ref object is the stable identity.
 * @example
 * ```ts
 * // lunora/client-queries.ts
 * import { createClientQuery } from "@lunora/client";
 *
 * export const sidebarOpen = createClientQuery("sidebarOpen", true);
 * export const selectedMessageId = createClientQuery("selectedMessageId", undefined as string | undefined);
 * ```
 */
const createClientQuery = <T>(key: string, defaultValue: T): ClientQueryRef<T> => {
    return { defaultValue, key };
};

export type { ClientQueryRef };
export { ClientQueryStore, createClientQuery };
