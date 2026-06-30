import { stableStringify } from "../../../shared/stable-key";
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
     * Invoked when a `settled` frame arrives for this subscription — the
     * list-path analog of the shape's poke `onCheckpoint`. The server
     * re-evaluated the query after a write and found the result unchanged; the
     * client advances the cursor/epoch and fires this so a `@lunora/db`
     * optimistic overlay can drop without re-rendering (no row callbacks fire).
     * Only the first `subscribe()` caller that provides this option wins;
     * subsequent callers sharing the deduped state do not override it.
     */
    onCheckpoint?: (watermark: { checkpoint?: number; mutationId?: number }) => void;

    /**
     * The `__cdc_log` high-watermark (`cursor`) the `lastValue` reflects,
     * captured from the last `data`/`delta`/`resume` frame. Persisted to the
     * durable read cache and replayed as `sinceSeq` on reconnect so the server
     * can resume instead of re-snapshotting (Pillar 1b/2). Absent until the
     * first cursor-stamped frame arrives.
     */
    serverCursor?: number;

    /**
     * The CDC `epoch` token the `serverCursor` belongs to, captured from the
     * same frame. Replayed as `sinceEpoch` on reconnect so the server resumes
     * only when the client is still on the same changelog timeline — a reset or
     * recycled shard advertises a new epoch, forcing a fresh snapshot. Absent
     * until the first epoch-stamped frame arrives.
     */
    serverEpoch?: string;

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
 * `(functionPath, stableStringify(args), shardKey)` so duplicate calls share a
 * single server-side registration. Args are stably encoded (keys sorted at every
 * depth) so two structurally-equal arg records constructed with a different key
 * order (`{ a, b }` vs `{ b, a }`) collapse to the same key instead of leaking a
 * duplicate subscription.
 */
export class SubscriptionRegistry {
    public static key(functionPath: string, args: Record<string, unknown>, shardKey?: string): string {
        return `${functionPath}::${stableStringify(args)}::${shardKey ?? ""}`;
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
