/**
 * Client-side incremental merging of structured mutation deltas.
 *
 * Lunora's live-query fan-out has two server paths:
 *
 * 1. Server re-execution (subscriptions carrying a `functionPath`) pushes a
 * full `data` snapshot whenever a write touches a table the query reads. These
 * already carry the authoritative result and are applied wholesale.
 * 2. Legacy delta fan-out (`broadcastDelta`) pushes a structured `MutationDelta`
 * as a `delta` frame to subscribers matched by table + args. The delta describes
 * a single row change (`insert` / `update` / `delete`) keyed by row id, so the
 * client can splice it into the cached list result without a full re-send.
 *
 * Historically the client treated the `delta` field as an opaque blob and
 * replaced the whole cached value with it on every message — which only made
 * sense for the rare delta payloads that already carried the full result. This
 * module lets the client recognise a structured delta and merge it into the
 * existing list (preserving order, no dup/loss), falling back to full
 * replacement when the payload isn't a recognisable row delta or can't be
 * applied cleanly against the current cached shape.
 *
 * The list shape and the insert-position rule come from `shared/page-result.ts`
 * rather than being defined here: the server runs the SAME functions to decide
 * whether a delta is safe to send at all, and a divergence between the two
 * would corrupt a live query silently. See that module's header.
 */

import { ID_FIELD, insertionIndexFor, PAGE_FIELD, rowListOf } from "../../../shared/page-result";

/**
 * One row change as emitted by `@lunora/do`'s `broadcastDelta`. Mirrors
 * `MutationDelta` in `@lunora/do` structurally so the client carries no
 * dependency on it. `row` is absent on `delete` events (and may be absent on
 * older servers for any op).
 */
interface MutationDelta {
    /** Row id (`_id`) the change applies to. */
    key: string;
    op: "delete" | "insert" | "update";
    row?: Record<string, unknown>;
    table: string;
}

/** Read a row's `_id`, coercing to string; `undefined` when the row has none. */
const rowId = (row: unknown): string | undefined => {
    if (typeof row !== "object" || row === null) {
        return undefined;
    }

    const id = (row as Record<string, unknown>)[ID_FIELD];

    return typeof id === "string" ? id : undefined;
};

/**
 * Structural guard: is `value` a `MutationDelta` the client knows how to merge?
 * We require `op`, `table`, and a string `key` so opaque payloads that merely
 * happen to be objects (e.g. an aggregate `{ count: 1 }` a query returns
 * verbatim) are never mistaken for a row delta and keep replacing the cached
 * value wholesale.
 */
const isMutationDelta = (value: unknown): value is MutationDelta => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const candidate = value as Record<string, unknown>;

    return (
        typeof candidate["key"] === "string" &&
        typeof candidate["table"] === "string" &&
        (candidate["op"] === "insert" || candidate["op"] === "update" || candidate["op"] === "delete")
    );
};

/**
 * Merge one row delta into an id-keyed row list, returning a new array.
 *
 * Matched by `_id`:
 * - `insert`: spliced at {@link insertionIndexFor} if absent; treated as an
 * update when a row with the same id is already present (idempotent — guards
 * against a delta replayed after a snapshot already included it).
 * - `update`: replaces the matching row in place, preserving its position.
 * - `delete`: removes the matching row; a delete for a row this list never held
 * is a legitimate no-op, not a failure.
 * @returns the merged rows, or `undefined` when the list isn't id-keyable or an insert/update carries no row
 */
const mergeRows = (list: ReadonlyArray<unknown>, delta: MutationDelta): undefined | unknown[] => {
    // Only merge when every element is an id-bearing object; a list of scalars
    // (or rows without `_id`) has no stable key to splice against.
    const rows: Record<string, unknown>[] = [];

    for (const element of list) {
        if (rowId(element) === undefined) {
            return undefined;
        }

        rows.push(element as Record<string, unknown>);
    }

    const { key, op, row } = delta;

    if (op === "delete") {
        const next = rows.filter((existing) => existing[ID_FIELD] !== key);

        return next.length === rows.length ? [...rows] : next;
    }

    // insert / update both need the new row body to splice in.
    if (row === undefined) {
        return undefined;
    }

    const next = [...rows];
    const existingIndex = rows.findIndex((existing) => existing[ID_FIELD] === key);

    if (existingIndex === -1) {
        next.splice(insertionIndexFor(rows, row), 0, row);
    } else {
        next[existingIndex] = row;
    }

    return next;
};

/**
 * Apply a structured `MutationDelta` to a cached list result, returning a new
 * value (never mutating the input). Returns `undefined` when the delta can't be
 * applied cleanly — the caller should then fall back to the existing
 * full-replacement behaviour (or trust the next snapshot to reconcile).
 *
 * Mergeable shapes: an array of id-bearing row objects, or a `.paginate()`
 * result wrapping one in `page` (see `rowListOf`). A paginated value keeps its
 * other fields and comes back as a new object with a new `page` — the server
 * only sends row deltas for that shape when everything outside the page is
 * unchanged, so the merged value matches the snapshot it chose not to send.
 * @returns the merged value, or `undefined` when the delta cannot be applied
 */
const applyDelta = (current: unknown, delta: MutationDelta): Record<string, unknown> | undefined | unknown[] => {
    const list = rowListOf(current);

    if (list === undefined) {
        return undefined;
    }

    const next = mergeRows(list, delta);

    // Re-wrap the way it arrived: a bare array stays an array, a paginated
    // result keeps `isDone`/`continueCursor` and swaps its page. One wrap point,
    // so no merge outcome can accidentally skip it.
    if (next === undefined || Array.isArray(current)) {
        return next;
    }

    return { ...(current as Record<string, unknown>), [PAGE_FIELD]: next };
};

export { applyDelta, isMutationDelta };
export type { MutationDelta };
