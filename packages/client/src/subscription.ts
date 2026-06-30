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

    /**
     * The highest custom-mutator `mutationId` from this client the server has
     * applied, captured from the last `settled` frame (the suppressed-list-frame
     * watermark). Forwarded to {@link SubscriptionState.checkpointCallbacks}.
     * Absent until a `settled` frame arrives.
     */
    lastMutationId?: number;
    /** Last known value, used to short-circuit `useQuery`-style consumers. */
    lastValue: unknown;

    /**
     * Notified when a `settled` frame advances this subscription's watermark — a
     * write touched the subscription's tables but the result was byte-identical,
     * so the server suppressed the data frame. A `@lunora/db` list collection
     * uses this to drop the optimistic overlay for the confirmed write.
     *
     * A SET (not a single slot) because `SubscriptionState` is SHARED across
     * every subscriber to the same `(fn, args, shardKey)`: a `@lunora/db`
     * collection may subscribe to a query a plain `useQuery` already opened, so
     * each subscriber registers its own callback (mirroring `callbacks` /
     * `errorCallbacks`) and a `settled` frame fans out to all of them. Plain
     * `useQuery` consumers register nothing, leaving the set empty.
     */
    readonly checkpointCallbacks: Set<(watermark: { checkpoint?: number; mutationId?: number }) => void>;

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
