import type { SubscriptionErrorCallback, SyncWatermark } from "./subscription";
import type { RowOp } from "./types";

/** Apply a shape's buffered row-ops to its keyed view in order: a delete removes the key, an upsert sets it (a value-less upsert is skipped — membership-only signal). */
export const applyRowOpsToView = (rows: Map<string, Record<string, unknown>>, ops: RowOp[]): void => {
    for (const op of ops) {
        if (op.op === "delete") {
            rows.delete(op.key);
        } else if (op.value !== undefined) {
            rows.set(op.key, op.value);
        }
    }
};

/** Callback a shape subscription invokes with its materialized rowset on every applied poke. */
export type ShapeCallback = (rows: Record<string, unknown>[]) => void;

/**
 * One live shape subscription's client state — the partial-replication parallel
 * to `SubscriptionState`. The view is a keyed map of the rows currently in
 * the shape (built up from seed + live poke diffs); `serverCursor`/`serverEpoch`
 * carry the last applied checkpoint so a reconnect resumes via `sinceCheckpoint`
 * instead of re-seeding.
 */
export interface ShapeSubscriptionState {
    args: Record<string, unknown> | undefined;
    callbacks: Set<ShapeCallback>;
    errorCallbacks: Set<SubscriptionErrorCallback>;
    id: string;
    /** Highest custom-mutator watermark the server has echoed for this client on this shape. */
    lastMutationId?: number;
    name: string;
    /** Invoked after each applied poke with the watermark this shape has now synced. */
    onCheckpoint?: (watermark: SyncWatermark) => void;
    /** The shape's current rowset, keyed by `_id`. */
    rows: Map<string, Record<string, unknown>>;
    serverCursor?: number;
    serverEpoch?: string;
    shardKey: string | undefined;

    /**
     * The wire-encoded form of `args`, computed once at `subscribeShape` time (so
     * an unsupported value fails loud at the call site, not inside a reconnect's
     * open handler). Sent on every `shape_subscribe` frame — identical to `args`
     * for pure JSON, tagged tokens for `bigint`/`Date`/bytes/… (the shard
     * `decodeWire`s them before resolving the shape).
     */
    wireArgs: Record<string, unknown> | undefined;
}

/** A poke being assembled between `pokeStart` and `pokeEnd` — parts buffered per shape, applied atomically at end. */
export interface PokeBuffer {
    /** Poke-level fallback base, used for a part that names none of its own. */
    baseCheckpoint: number | undefined;

    /** Per-shape base checkpoint: the cursor this shape's view must be at for the part's diff to splice on cleanly. */
    bases: Map<string, number>;
    epoch: string | undefined;
    lastMutationId: Map<string, number>;
    parts: Map<string, RowOp[]>;

    /** Shapes whose part carries the COMPLETE membership — their view is dropped before the ops apply. */
    resets: Set<string>;

    /** Shapes a part carried a row the codec refused for, with the reason — their slice of the poke is refused whole at `pokeEnd`. */
    undecodable: Map<string, unknown>;
}
