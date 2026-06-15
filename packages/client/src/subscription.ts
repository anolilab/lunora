import type { FunctionReference } from "./types";

export type SubscriptionCallback = (data: unknown) => void;

/** A subscription-scoped error the server pushed for this subscription id. */
export interface SubscriptionError {
    code?: string;
    message: string;
}

export type SubscriptionErrorCallback = (error: SubscriptionError) => void;

export interface SubscriptionState {
    /** True once the server has acked the subscription on the current socket. */
    acked: boolean;
    readonly args: Record<string, unknown>;

    /**
     * Stable-stringified `args`, computed once at subscribe time. Cached so the
     * optimistic-update fan-out can compare against a mutation's args key without
     * re-serializing every subscription's args on every mutation.
     */
    readonly argsKey: string;
    readonly callbacks: Set<SubscriptionCallback>;
    /** Notified when the server rejects this subscription (e.g. admin auth). */
    readonly errorCallbacks: Set<SubscriptionErrorCallback>;
    readonly fn: FunctionReference;
    readonly id: string;
    /** Last known value, used to short-circuit `useQuery`-style consumers. */
    lastValue: unknown;

    /**
     * Monotonic counter incremented on every server-pushed delta or data.
     * Used by optimistic-update rollback to detect whether the server has
     * already moved past the value we'd otherwise restore.
     */
    serverVersion: number;
    readonly shardKey?: string;
}

/**
 * Active subscription registry. The client keys subscriptions by
 * `(functionPath, JSON.stringify(args), shardKey)` so duplicate calls share a
 * single server-side registration.
 */
export class SubscriptionRegistry {
    public static key(functionPath: string, args: Record<string, unknown>, shardKey?: string): string {
        return `${functionPath}::${JSON.stringify(args)}::${shardKey ?? ""}`;
    }

    private readonly byKey = new Map<string, SubscriptionState>();

    private readonly byId = new Map<string, SubscriptionState>();

    public get(key: string): SubscriptionState | undefined {
        return this.byKey.get(key);
    }

    public getById(id: string): SubscriptionState | undefined {
        return this.byId.get(id);
    }

    public add(state: SubscriptionState): void {
        this.byKey.set(SubscriptionRegistry.key(state.fn.__lunoraRef, state.args, state.shardKey), state);
        this.byId.set(state.id, state);
    }

    public remove(state: SubscriptionState): void {
        this.byKey.delete(SubscriptionRegistry.key(state.fn.__lunoraRef, state.args, state.shardKey));
        this.byId.delete(state.id);
    }

    public all(): SubscriptionState[] {
        return [...this.byKey.values()];
    }
}
