/**
 * Pure membership-diff + poke-framing helpers for the shape poke path, extracted
 * from the `ShardDO` god-class so they're unit-testable in isolation (no DO /
 * `this` dependency, no store access).
 *
 * A `.global()` (D1) table has no per-DO op-log, so its shape is served by
 * re-reading full membership each alarm tick and diffing it against the rows
 * last poked to the socket — {@link diffGlobalMembership} is that diff.
 * {@link buildPokeFrames} is the wire framing every poke (global or poke-live)
 * is sent as. `shard-do.ts` consumes both.
 */

import { encodeWire } from "../../../shared/wire-codec";
import type { ShapeRow } from "./ctx-db-shapes";

/** Wire form of a single shape row change (the DO-side mirror of `@lunora/client`'s `RowOp`; kept local so `@lunora/do` takes no client dependency). */
interface ShapeRowOp {
    key: string;
    op: "delete" | "insert" | "update";
    table: string;
    value?: Record<string, unknown>;
}

/**
 * One shape's slice of a poke: the subscription id it belongs to plus its
 * ordered row-ops.
 *
 * `baseCheckpoint` and `reset` are PER SHAPE, not per poke, because a single
 * poke can carry one part per shape and every shape on a socket has its own
 * delivered-through cursor (`pokeShapeSubscribers` diffs each from its own
 * memo). A poke-level base would be right for at most one of them.
 */
interface ShapePokePart {
    /**
     * The checkpoint the client's view of THIS shape must be at for the part's
     * diff to splice on cleanly — the cursor of the last poke actually delivered
     * for it. A mismatch means a poke went missing and the client must re-seed.
     * `undefined` when the sender cannot name a base (see {@link PokeFrameMeta.baseCheckpoint}).
     */
    baseCheckpoint?: number;

    /**
     * `true` when `rowsPatch` is the shape's COMPLETE membership rather than a
     * diff — the client must drop its current view before applying, or a row
     * that left the shape while it was disconnected survives forever (a full
     * seed is inserts-only and can never delete).
     *
     * This is explicit on the wire and never inferred: an absent
     * `baseCheckpoint` does NOT imply a seed (most live poke paths have no base
     * to name), so the two are independent flags.
     */
    reset?: boolean;
    rowsPatch: ShapeRowOp[];
    shapeId: string;
}

/** The checkpoint/epoch metadata stamped on a poke's `pokeStart`/`pokeEnd` frames. */
interface PokeFrameMeta {
    /**
     * Poke-level fallback base for a SINGLE-part poke (the seed paths). Stamped
     * on `pokeStart` for non-JS SDK clients, which read it there, and folded into
     * any part that names no base of its own. A multi-shape poke must set the
     * base per part instead — see {@link ShapePokePart.baseCheckpoint}.
     */
    baseCheckpoint: number | undefined;
    checkpoint: number;
    epoch: string | undefined;

    /**
     * The recipient client's `__client_watermark` (highest mutation id the DO
     * has processed from it), stamped on each `pokePart` so a `@lunora/db`
     * collection can drop the optimistic overlay for writes this poke synced.
     * `undefined` for sockets with no recorded `clientId` (no custom mutators).
     */
    lastMutationId: number | undefined;
    pokeId: string;
}

/**
 * Project a shape row's post-image to the shape's declared `columns` (its
 * column allow-list), always retaining `_id`/`_creationTime` so the client can
 * key and order. Absent `columns` ⇒ the full document is shipped verbatim.
 */
const projectColumns = (document_: Record<string, unknown>, columns: ReadonlyArray<string> | undefined): Record<string, unknown> => {
    if (!columns) {
        return document_;
    }

    // Null-prototype target + own-property check: a column literally named
    // `__proto__`/`constructor` must be copied as a plain data field, never walk
    // the prototype chain or mutate the result's prototype.
    const projected = Object.create(null) as Record<string, unknown>;

    for (const key of ["_id", "_creationTime", ...columns]) {
        if (Object.hasOwn(document_, key)) {
            projected[key] = document_[key];
        }
    }

    return projected;
};

/**
 * Diff a global shape's freshly-read membership against the socket's previous
 * snapshot. Returns the next snapshot (`id → projected-value JSON`, the baseline
 * the following tick diffs from) and the minimal row-ops to bring the client
 * from `previous` to it: a new key → `insert`, a changed projected value →
 * `update`, a vanished key → `delete`. Seeding is the same call with an empty
 * `previous` — every surviving row becomes an `insert`.
 */
const diffGlobalMembership = (
    rows: ReadonlyArray<ShapeRow>,
    previous: ReadonlyMap<string, string>,
    options: { columns?: ReadonlyArray<string>; table: string },
): { next: Map<string, string>; rowsPatch: ShapeRowOp[] } => {
    const { columns, table } = options;
    const next = new Map<string, string>();
    const rowsPatch: ShapeRowOp[] = [];

    for (const { doc, id } of rows) {
        const value = projectColumns(doc, columns);
        // Encode before fingerprinting so a `bytes`/`bigint` column doesn't throw
        // / truncate; pure-JSON values encode byte-identically (baseline unchanged).
        const json = JSON.stringify(encodeWire(value));

        next.set(id, json);

        const before = previous.get(id);

        if (before === undefined) {
            rowsPatch.push({ key: id, op: "insert", table, value });
        } else if (before !== json) {
            rowsPatch.push({ key: id, op: "update", table, value });
        }
    }

    for (const id of previous.keys()) {
        if (!next.has(id)) {
            rowsPatch.push({ key: id, op: "delete", table });
        }
    }

    return { next, rowsPatch };
};

/**
 * Wire-encode each row-op's post-image in a `rowsPatch`. `delete` ops carry no
 * value; a pure-JSON value encodes byte-identically. Exposed so a caller can make
 * a `rowsPatch` `JSON.stringify`-safe for a hop that happens BEFORE
 * {@link buildPokeFrames} runs — notably the owner→relay poke forward, where the
 * raw structured poke crosses the hub and a `bytes`/`bigint` column would
 * otherwise throw (`bigint`) or truncate to `{}` (`ArrayBuffer`).
 */
const encodeRowsPatch = (rowsPatch: ReadonlyArray<ShapeRowOp>): ShapeRowOp[] =>
    rowsPatch.map((op) => (op.value === undefined ? op : { ...op, value: encodeWire(op.value) as Record<string, unknown> }));

/**
 * Build the ordered wire frames of one poke: a `pokeStart`, one `pokePart` per
 * shape slice, then a `pokeEnd`. All parts apply atomically at `pokeEnd`.
 * Returned as serialized JSON strings ready to hand to `ws.send`, so the caller
 * owns only the send loop and its error containment.
 *
 * Each `pokePart` carries its shape's own `baseCheckpoint` and `reset` flag —
 * see {@link ShapePokePart}. A part flagged `reset` replaces the client's view
 * instead of splicing onto it; without that flag on the wire a full re-seed is
 * byte-indistinguishable from a delta and silently merges into a stale view.
 *
 * `options.preEncoded` is set by callers whose `rowsPatch` values were ALREADY
 * wire-encoded upstream (the relay-deliver path — the owner encodes them before
 * forwarding the poke across the hub, since the structured poke crosses a
 * `JSON.stringify` there). `encodeWire` is not idempotent, so a second pass would
 * double-tag; those callers pass `preEncoded: true`. Everyone else passes raw
 * values and lets this function do the single encode.
 */
const buildPokeFrames = (parts: ReadonlyArray<ShapePokePart>, meta: PokeFrameMeta, options: { preEncoded?: boolean } = {}): string[] => {
    const { baseCheckpoint, checkpoint, epoch, lastMutationId, pokeId } = meta;
    const frames: string[] = [JSON.stringify({ baseCheckpoint, epoch, pokeId, type: "pokeStart" })];

    for (const part of parts) {
        // The single wire-encode choke point for the direct (global / op-log)
        // poke paths. The relay-deliver path already encoded upstream (see
        // `preEncoded`), so it skips the second pass.
        const rowsPatch = options.preEncoded ? part.rowsPatch : encodeRowsPatch(part.rowsPatch);
        // The part's own base wins; `meta.baseCheckpoint` is the fallback for the
        // single-part seed callers that still name it at the poke level.
        const partBase = part.baseCheckpoint ?? baseCheckpoint;

        frames.push(
            JSON.stringify({
                pokeId,
                rowsPatch,
                shapeId: part.shapeId,
                type: "pokePart",
                ...(lastMutationId === undefined ? {} : { lastMutationId }),
                ...(partBase === undefined ? {} : { baseCheckpoint: partBase }),
                ...(part.reset === true ? { reset: true } : {}),
            }),
        );
    }

    frames.push(JSON.stringify({ checkpoint, epoch, pokeId, type: "pokeEnd" }));

    return frames;
};

export type { PokeFrameMeta, ShapePokePart, ShapeRowOp };
export { buildPokeFrames, diffGlobalMembership, encodeRowsPatch, projectColumns };
