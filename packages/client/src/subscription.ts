import type { FunctionReference } from "./types.js";

export type SubscriptionCallback = (data: unknown) => void;

export interface SubscriptionState {
    /** True once the server has acked the subscription on the current socket. */
    acked: boolean;
    readonly args: Record<string, unknown>;
    readonly callbacks: Set<SubscriptionCallback>;
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
    private readonly byKey = new Map<string, SubscriptionState>();

    private readonly byId = new Map<string, SubscriptionState>();

    public key(functionPath: string, args: Record<string, unknown>, shardKey?: string): string {
        return `${functionPath}::${JSON.stringify(args ?? {})}::${shardKey ?? ""}`;
    }

    public get(key: string): SubscriptionState | undefined {
        return this.byKey.get(key);
    }

    public getById(id: string): SubscriptionState | undefined {
        return this.byId.get(id);
    }

    public add(state: SubscriptionState): void {
        this.byKey.set(this.key(state.fn.__cirrusRef, state.args, state.shardKey), state);
        this.byId.set(state.id, state);
    }

    public remove(state: SubscriptionState): void {
        this.byKey.delete(this.key(state.fn.__cirrusRef, state.args, state.shardKey));
        this.byId.delete(state.id);
    }

    public all(): SubscriptionState[] {
        return [...this.byKey.values()];
    }

    public markAllPendingAck(): void {
        for (const state of this.byKey.values()) {
            state.acked = false;
        }
    }
}
