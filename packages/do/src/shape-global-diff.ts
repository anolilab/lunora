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

import type { ShapeRow } from "./ctx-db-shapes";

/** Wire form of a single shape row change (the DO-side mirror of `@lunora/client`'s `RowOp`; kept local so `@lunora/do` takes no client dependency). */
interface ShapeRowOp {
    key: string;
    op: "delete" | "insert" | "update";
    table: string;
    value?: Record<string, unknown>;
}

/** One shape's slice of a poke: the subscription id it belongs to plus its ordered row-ops. */
interface ShapePokePart {
    rowsPatch: ShapeRowOp[];
    shapeId: string;
}

/** The checkpoint/epoch metadata stamped on a poke's `pokeStart`/`pokeEnd` frames. */
interface PokeFrameMeta {
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
        const json = JSON.stringify(value);

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
 * Build the ordered wire frames of one poke: a `pokeStart`, one `pokePart` per
 * shape slice, then a `pokeEnd`. All parts apply atomically at `pokeEnd`.
 * Returned as serialized JSON strings ready to hand to `ws.send`, so the caller
 * owns only the send loop and its error containment.
 */
const buildPokeFrames = (parts: ReadonlyArray<ShapePokePart>, meta: PokeFrameMeta): string[] => {
    const { baseCheckpoint, checkpoint, epoch, lastMutationId, pokeId } = meta;
    const frames: string[] = [JSON.stringify({ baseCheckpoint, epoch, pokeId, type: "pokeStart" })];

    for (const part of parts) {
        frames.push(
            JSON.stringify({
                pokeId,
                rowsPatch: part.rowsPatch,
                shapeId: part.shapeId,
                type: "pokePart",
                ...(lastMutationId === undefined ? {} : { lastMutationId }),
            }),
        );
    }

    frames.push(JSON.stringify({ checkpoint, epoch, pokeId, type: "pokeEnd" }));

    return frames;
};

export type { PokeFrameMeta, ShapePokePart, ShapeRowOp };
export { buildPokeFrames, diffGlobalMembership, projectColumns };
