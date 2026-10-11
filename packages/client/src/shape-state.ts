import { evictOldestEntry } from "../../../shared/evict-oldest";
import { decodeWire } from "../../../shared/wire-codec";
import { connectionKey } from "./connection-state";
import type { SubscriptionErrorCallback, SyncWatermark } from "./subscription";
import type { RowOp, ServerPokeEndMessage, ServerPokePartMessage, ServerPokeStartMessage } from "./types";

/**
 * Buffer key for an in-flight poke. The connection has to be in the key: `pokeId` is a per-DO
 * counter that also resets on eviction, so a multi-shard client (one socket per shard, one map)
 * sees two shards mint `poke-1` concurrently. Keyed by `pokeId` alone, their frames interleave into
 * one buffer: one shard applies the other's epoch, and the other finds no buffer for its parts.
 */
const pokeBufferKey = (shardKey: string | undefined, pokeId: string): string => `${connectionKey(shardKey)}\u0000${pokeId}`;

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

/**
 * Buffers a poke between `pokeStart` and `pokeEnd`, so its parts apply atomically
 * or not at all. A socket that drops mid-poke leaves every view untouched, and the
 * server re-seeds on resume.
 *
 * The assembler only holds and decodes. It never touches a shape: `end` hands the
 * finished buffer to the caller, which decides what to commit.
 */
export class PokeAssembler {
    private readonly buffers = new Map<string, PokeBuffer>();

    public constructor(private readonly maxBuffers: number) {}

    /** Open a buffer for `message.pokeId`, evicting the oldest one past the cap. */
    public start(shardKey: string | undefined, message: ServerPokeStartMessage): void {
        // A buffer whose socket drops before `pokeEnd` is abandoned, and it is always
        // the oldest, so the cap only ever reclaims dead buffers in practice.
        evictOldestEntry(this.buffers, this.maxBuffers);

        this.buffers.set(pokeBufferKey(shardKey, message.pokeId), {
            baseCheckpoint: message.baseCheckpoint,
            bases: new Map(),
            epoch: message.epoch,
            lastMutationId: new Map(),
            parts: new Map(),
            resets: new Set(),
            undecodable: new Map(),
        });
    }

    /**
     * Add one shape's part to its poke. A part for an unknown poke is ignored: the
     * server re-seeds the shape on the next subscribe.
     */
    public part(shardKey: string | undefined, message: ServerPokePartMessage): void {
        const buffer = this.buffers.get(pokeBufferKey(shardKey, message.pokeId));

        if (!buffer) {
            return;
        }

        // Decode into a scratch list before buffering anything. A row the codec
        // refuses must not leave a half-pushed part behind it.
        const decoded: RowOp[] = [];

        try {
            for (const op of message.rowsPatch) {
                decoded.push(op.value === undefined ? op : { ...op, value: decodeWire(op.value) as Record<string, unknown> });
            }
        } catch (error) {
            buffer.undecodable.set(message.shapeId, error);

            return;
        }

        const existing = buffer.parts.get(message.shapeId) ?? [];

        for (const op of decoded) {
            existing.push(op);
        }

        buffer.parts.set(message.shapeId, existing);

        if (message.lastMutationId !== undefined) {
            buffer.lastMutationId.set(message.shapeId, message.lastMutationId);
        }

        const base = message.baseCheckpoint ?? buffer.baseCheckpoint;

        if (base !== undefined) {
            buffer.bases.set(message.shapeId, base);
        }

        // Sticky: a server that splits one seed across parts still replaces, not merges.
        if (message.reset === true) {
            buffer.resets.add(message.shapeId);
        }
    }

    /** Remove and return a poke's buffer, or `undefined` when it was never started. */
    public end(shardKey: string | undefined, pokeId: string): PokeBuffer | undefined {
        const key = pokeBufferKey(shardKey, pokeId);
        const buffer = this.buffers.get(key);

        if (buffer) {
            this.buffers.delete(key);
        }

        return buffer;
    }

    /** Drop every buffer, on close. */
    public clear(): void {
        this.buffers.clear();
    }
}

/**
 * Commit one shape's slice of a poke, or refuse it and ask for a re-seed.
 *
 * Mutates `state` and returns what the caller must do next: `"applied"` means emit
 * the rows, then fire `onCheckpoint`; `"reseed"` means emit the cleared view, then
 * re-subscribe. Every decision is per shape: the reset flag, the base checkpoint,
 * the epoch and the watermark.
 */
export const commitPokeSlice = (state: ShapeSubscriptionState, buffer: PokeBuffer, message: ServerPokeEndMessage): "applied" | "reseed" => {
    const ops = buffer.parts.get(state.id) ?? [];
    // A `reset` part carries the shape's COMPLETE membership, so it is authoritative
    // on its own. Drop the stale view and apply it, even across a forked epoch or a
    // diverged base. A seed is inserts-only, so without this every row deleted while
    // the client was disconnected would survive the reconnect.
    const reset = buffer.resets.has(state.id);

    // An epoch mismatch means the changelog forked; a base mismatch means this diff
    // was computed against a checkpoint the view is not at. Splicing either would
    // corrupt the view, so drop it, clear the cursor and re-seed.
    const base = buffer.bases.get(state.id);
    const epochForked = buffer.epoch !== undefined && state.serverEpoch !== undefined && buffer.epoch !== state.serverEpoch;
    const baseDiverged = base !== undefined && state.serverCursor !== undefined && state.serverCursor !== base;

    /* eslint-disable no-param-reassign -- advance the shared shape-subscription state in place */
    if (!reset && (epochForked || baseDiverged)) {
        state.rows.clear();
        state.serverCursor = undefined;
        state.serverEpoch = undefined;

        return "reseed";
    }

    if (reset) {
        state.rows.clear();
    }

    applyRowOpsToView(state.rows, ops);

    if (message.checkpoint !== undefined) {
        state.serverCursor = message.checkpoint;
    }

    if (message.epoch !== undefined) {
        state.serverEpoch = message.epoch;
    }

    const watermark = buffer.lastMutationId.get(state.id);

    if (watermark !== undefined) {
        state.lastMutationId = watermark;
    }
    /* eslint-enable no-param-reassign */

    return "applied";
};
