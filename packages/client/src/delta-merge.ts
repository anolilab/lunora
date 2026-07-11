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
 * existing array (preserving order, no dup/loss), falling back to full
 * replacement when the payload isn't a recognisable row delta or can't be
 * applied cleanly against the current cached shape.
 */

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

/** Identity field every Lunora document row carries. */
const ID_FIELD = "_id";

/** Creation-time field used as the default sort key for inserts. */
const CREATION_FIELD = "_creationTime";

/** Read a row's `_id`, coercing to string; `undefined` when the row has none. */
const rowId = (row: unknown): string | undefined => {
    if (typeof row !== "object" || row === null) {
        return undefined;
    }

    const id = (row as Record<string, unknown>)[ID_FIELD];

    return typeof id === "string" ? id : undefined;
};

/**
 * Detect the ordering direction of a cached list from its existing rows'
 * `_creationTime` run. Returns `true` when the list is sorted descending
 * (newest-first — the common chat/feed shape), `false` for ascending or when the
 * direction is indeterminate (0/1 numeric rows, or an all-equal run). We read the
 * FIRST strictly-ordered adjacent numeric pair, so a single out-of-order row
 * doesn't flip the verdict.
 */
const isDescending = (list: Record<string, unknown>[]): boolean => {
    let previous: number | undefined;

    for (const existingRow of list) {
        const existing = existingRow[CREATION_FIELD];

        if (typeof existing !== "number") {
            continue;
        }

        if (previous !== undefined) {
            if (existing < previous) {
                return true;
            }

            if (existing > previous) {
                return false;
            }
        }

        previous = existing;
    }

    return false;
};

/**
 * Decide where to insert a new row into an already-ordered list so the merge
 * preserves the cached ordering. When both the new row and the neighbours carry a
 * numeric `_creationTime` we honour the list's OWN direction — ascending (the
 * server's default sort) inserts before the first larger neighbour; descending
 * (a newest-first feed) inserts before the first smaller one, so a freshly
 * inserted newest row lands at the front instead of being appended to the end.
 * With no usable ordering we append, keeping insertion order and never reordering
 * existing rows.
 */
const insertionIndex = (list: Record<string, unknown>[], row: Record<string, unknown>): number => {
    const creation = row[CREATION_FIELD];

    if (typeof creation !== "number") {
        return list.length;
    }

    const descending = isDescending(list);

    for (const [index, existingRow] of list.entries()) {
        const existing = existingRow[CREATION_FIELD];

        if (typeof existing === "number" && (descending ? existing < creation : existing > creation)) {
            return index;
        }
    }

    return list.length;
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
 * Apply a structured `MutationDelta` to a cached array result, returning a new
 * array (never mutating the input). Returns `undefined` when the delta can't be
 * applied cleanly — the caller should then fall back to the existing
 * full-replacement behaviour (or trust the next snapshot to reconcile).
 *
 * Mergeable shape: a plain array of id-bearing row objects, e.g. the result of
 * `db.query().collect()`.
 *
 * Insert / update / delete are matched by row `_id`:
 * - `insert`: appended (or placed by `_creationTime` order) if absent; treated
 * as an update if a row with the same id already exists (idempotent — guards
 * against a delta replayed after a snapshot already included it).
 * - `update`: replaces the matching row in place, preserving its position.
 * - `delete`: removes the matching row.
 *
 * Returns `undefined` when `current` isn't an array of id-keyable objects, or
 * when an `insert`/`update` delta carries no `row` to splice in.
 */
const applyDelta = (current: unknown, delta: MutationDelta): undefined | unknown[] => {
    if (!Array.isArray(current)) {
        return undefined;
    }

    // Only merge when every element is an id-bearing object; an array of
    // scalars (or rows without `_id`) has no stable key to splice against.
    const rows: Record<string, unknown>[] = [];

    for (const element of current) {
        const id = rowId(element);

        if (id === undefined) {
            return undefined;
        }

        rows.push(element as Record<string, unknown>);
    }

    const { key, op, row } = delta;

    if (op === "delete") {
        const next = rows.filter((existing) => existing[ID_FIELD] !== key);

        // No row matched: the delete is a no-op for this page. Return the
        // (copied) list unchanged rather than bailing — a delete for a row this
        // page never held is legitimately nothing to do.
        return next.length === rows.length ? [...rows] : next;
    }

    // insert / update both need the new row body to splice in.
    if (row === undefined) {
        return undefined;
    }

    const existingIndex = rows.findIndex((existing) => existing[ID_FIELD] === key);

    if (existingIndex === -1) {
        // Absent → insert at the order-preserving position.
        const next = [...rows];

        next.splice(insertionIndex(rows, row), 0, row);

        return next;
    }

    // Present → replace in place (covers `update`, and an `insert` whose row a
    // snapshot already delivered — idempotent).
    const next = [...rows];

    next[existingIndex] = row;

    return next;
};

export { applyDelta, isMutationDelta };
export type { MutationDelta };
