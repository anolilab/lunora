import type { LunoraErrorCodeInput } from "@lunora/errors";

import { stableWireKey } from "../../../shared/wire-key";
import type { FunctionReference } from "./types";

export type SubscriptionCallback = (data: unknown) => void;

/**
 * The high-water marks a shape poke has now synced to the client: `checkpoint`
 * is the op-log cursor and `mutationId` the highest custom-mutator id the server
 * echoed for this client. A `@lunora/db` collection feeds these into its
 * checkpoint registry to drop optimistic overlays once the server's authoritative
 * rows have landed.
 */
export interface SyncWatermark {
    checkpoint?: number;
    mutationId?: number;

    /**
     * `true` only on the checkpoint a `data`/`delta` frame fires immediately
     * before that same frame's rowset callback — i.e. the one checkpoint whose
     * `mutationId` describes rows that are about to arrive.
     *
     * A `settled` frame (and a cross-tab `subscription-settled` relay) fires a
     * checkpoint with NO matching rowset, because the server suppressed a data
     * frame whose value didn't change. A consumer that stashes `mutationId` for
     * the next rowset to consume — `@lunora/db`'s `pendingFrameWatermark` — must
     * not stash those, or the value sits until some later unstamped frame eats
     * it and the checkpoint gate resolves at a stale watermark instead of
     * falling back to the RPC-ack compensator.
     */
    rowsFollow?: boolean;
}

/** A subscription-scoped error the server pushed for this subscription id. */
export interface SubscriptionError {
    /**
     * The coded reason, when the frame carried one. `LunoraErrorCodeInput`, not
     * `LunoraErrorCode`: the catalog codes autocomplete for a consumer branching
     * on this (the shard sends `BAD_SUBSCRIPTION_ARGS`, `TOO_MANY_SUBSCRIPTIONS`,
     * `SUBSCRIPTION_PERSIST_FAILED`, …; the client itself adds
     * `WIRE_DECODE_FAILED` for a frame `decodeWire` refuses), but this value is
     * read verbatim off the wire and nothing validates it against the catalog,
     * so narrowing it to `LunoraErrorCode` would be a lie a newer server tells.
     */
    code?: LunoraErrorCodeInput;
    message: string;
}

export type SubscriptionErrorCallback = (error: SubscriptionError) => void;

/**
 * One active per-call optimistic transform layered onto a subscription. The
 * displayed value is the authoritative {@link SubscriptionState.serverBase}
 * folded through every layer's `transform`, in order — so an incoming server
 * frame re-folds the still-pending layers onto the new base (rebasing) instead
 * of clobbering them. A layer is dropped — gaplessly — once a `data`/`delta`
 * frame whose `cursor >= commitCursor` arrives (its write is now reflected in
 * `serverBase`); `commitCursor` is the CDC cursor the server echoed on the
 * mutation's response, and stays `undefined` while the write is still queued/
 * in-flight (so the overlay survives unrelated deltas until confirmed).
 */
export interface OptimisticLayer {
    /** The committed CDC cursor (from the mutation response); `undefined` until confirmed. */
    commitCursor?: number;
    readonly id: symbol;
    readonly transform: (current: unknown) => unknown;
}

export interface SubscriptionState {
    /** True once the server has acked the subscription on the current socket. */
    acked: boolean;
    readonly args: Record<string, unknown>;

    /**
     * Stable wire-key of `args` (`stableWireKey`), computed once at subscribe
     * time. Cached so the optimistic-update fan-out can compare against a
     * mutation's args key without re-serializing every subscription's args on
     * every mutation.
     */
    readonly argsKey: string;
    readonly callbacks: Set<SubscriptionCallback>;

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
    readonly checkpointCallbacks: Set<(watermark: SyncWatermark) => void>;
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
     * Active per-call optimistic layers, in application order (see
     * {@link OptimisticLayer}). Empty for subscriptions with no pending per-call
     * optimistic write — the common case, where `lastValue` tracks `serverBase`
     * exactly and behaviour is identical to a plain server-value assignment.
     */
    optimisticLayers: OptimisticLayer[];

    /**
     * The authoritative server value the optimistic layers fold onto — the value
     * with NO optimistic overlay. Tracks `lastValue` exactly whenever no layers
     * are active; diverges only while a per-call optimistic write is pending. A
     * server frame updates this (and re-folds the layers); the durable read cache
     * persists this, never the optimistic overlay.
     */
    serverBase: unknown;

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
    readonly shardKey?: string;

    /**
     * The wire-encoded form of `args`, computed once at `subscribe` time (so an
     * unsupported value fails loud at the call site, not inside a reconnect's
     * open handler). Sent on every `subscribe` frame — identical to `args` for
     * pure JSON, tagged tokens for `bigint`/`Date`/bytes/… (the shard
     * `decodeWire`s them at its subscribe entry point).
     *
     * A SNAPSHOT, not a view: `args` is the caller's own object, retained by
     * reference and never copied, so a caller that mutates it after subscribing
     * would otherwise poison every later resubscribe. `encodeWire` rebuilds
     * every container, so this copy is immune to that.
     */
    readonly wireArgs: Record<string, unknown>;
}

/**
 * Active subscription registry. The client keys subscriptions by
 * `(functionPath, stableWireKey(args), shardKey)` so duplicate calls share a
 * single server-side registration. Args are stably encoded (keys sorted at every
 * depth) so two structurally-equal arg records constructed with a different key
 * order (`{ a, b }` vs `{ b, a }`) collapse to the same key instead of leaking a
 * duplicate subscription. Encoding the args' **wire form** keeps the key
 * byte-identical for pure-JSON args while giving wire-typed args (`bigint`,
 * `Date`, bytes, …) distinct stable tokens instead of a throw.
 */
export class SubscriptionRegistry {
    public static key(functionPath: string, args: Record<string, unknown>, shardKey?: string): string {
        return `${functionPath}::${stableWireKey(args)}::${shardKey ?? ""}`;
    }

    /**
     * The registry key of an already-registered state, from its cached
     * {@link SubscriptionState.argsKey}. Re-deriving it from `state.args` would
     * re-read the caller's own (mutable) args object, so a caller that mutated
     * its args after subscribing would compute a DIFFERENT key on unsubscribe
     * and leak the registration forever.
     */
    public static keyOf(state: SubscriptionState): string {
        return `${state.fn.__lunoraRef}::${state.argsKey}::${state.shardKey ?? ""}`;
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
        this.byKey.set(SubscriptionRegistry.keyOf(state), state);
        this.byId.set(state.id, state);
    }

    public remove(state: SubscriptionState): void {
        const key = SubscriptionRegistry.keyOf(state);

        // Identity-checked: only evict the `byKey` slot when it still maps to
        // THIS state. After a server `complete` removed S1, a fresh subscription
        // (S2) under the same (fn, args, shardKey) may have re-claimed the slot;
        // a late unsubscribe of S1 must not delete S2's slot (which would hide S2
        // from `subscribe()`'s dedup and the optimistic keyed lookup even though
        // it keeps receiving frames via `byId`).
        if (this.byKey.get(key) === state) {
            this.byKey.delete(key);
        }

        this.byId.delete(state.id);
    }

    public all(): SubscriptionState[] {
        return [...this.byKey.values()];
    }

    /**
     * Drop every registration. Terminal — used by `LunoraClient.close()`, whose
     * whole point is to release the callback closures each {@link SubscriptionState}
     * holds (`callbacks`, `errorCallbacks`, `checkpointCallbacks` — React state
     * setters and `@lunora/db` collection closures), which otherwise outlive the
     * closed client for as long as the client object is reachable.
     */
    public clear(): void {
        this.byKey.clear();
        this.byId.clear();
    }
}
