/**
 * Subscription wire-delivery for the DO store: the keyed list-diff encoder
 * (`subscriptionListDeltas` + its row-indexing helpers) and the best-effort
 * frame senders (`trySendFrame`/`sendDeltaFrames`).
 *
 * Extracted from `shard-do.ts` as a cohesive unit — these are pure functions
 * with no `this`/instance state: they turn a previous-vs-next query result into
 * the `{type:"delta"}` row deltas the client merges in place, and push frames
 * onto a hibernatable `WebSocket`, reporting whether each frame left the socket
 * so the caller can protect its diff baseline. `shard-do.ts` imports these and
 * re-exports `subscriptionListDeltas` so existing import sites (the index
 * barrel, tests) are unchanged.
 */

import { encodeWire } from "../../../shared/wire-codec";
import type { MutationDelta } from "./types";

/** Identity field every Lunora document row carries. */
const ROW_ID_FIELD = "_id";

/**
 * Fallback table name stamped on a delta when the subscription's read-table
 * set is empty. The client only uses `table` for its structural guard
 * ({@link MutationDelta} recognition) — `key`/`row`/`op` drive the actual
 * merge — so any non-empty string is safe.
 */
const DELTA_FALLBACK_TABLE = "__lunora__";

/**
 * Read a row's `_id` as a string; `undefined` when the row isn't a plain object with a string `_id`.
 * @returns the `_id` string, or `undefined` when the row is not a plain object with a string `_id`
 */
const readRowId = (row: unknown): string | undefined => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
        return undefined;
    }

    const id = (row as Record<string, unknown>)[ROW_ID_FIELD];

    return typeof id === "string" ? id : undefined;
};

/**
 * Index an array of rows by `_id`, preserving insertion order. Returns
 * `undefined` the moment any element lacks a string `_id` (the diff can't key
 * such a list) — the caller then falls back to a full snapshot.
 *
 * Also bails on a duplicate `_id`: the delta protocol keys rows by `_id`, so a
 * list carrying the same `_id` twice (e.g. a relational join that fans a parent
 * out across children) cannot be expressed as deltas — the client would merge
 * the collisions down to a single row and silently lose the duplicates, leaving
 * its view shorter than the snapshot path. Returning `undefined` here forces the
 * full-snapshot fallback so both paths agree.
 * @returns the indexed map and insertion order, or `undefined` when any row lacks a string `_id` or ids are duplicated
 */
const indexRowsById = (rows: unknown[]): undefined | { byId: Map<string, Record<string, unknown>>; order: string[] } => {
    const byId = new Map<string, Record<string, unknown>>();
    const order: string[] = [];

    for (const row of rows) {
        const id = readRowId(row);

        if (id === undefined || byId.has(id)) {
            return undefined;
        }

        byId.set(id, row as Record<string, unknown>);
        order.push(id);
    }

    return { byId, order };
};

/**
 * True when the rows present in BOTH lists keep the same relative order. The
 * client merges updates in place and never reorders, so a survivor that moved
 * can't be expressed as deltas.
 */
const survivorsKeepOrder = (
    previous: { byId: Map<string, Record<string, unknown>>; order: string[] },
    next: { byId: Map<string, Record<string, unknown>>; order: string[] },
): boolean => {
    const survivingPrevious = previous.order.filter((id) => next.byId.has(id));
    const survivingNext = next.order.filter((id) => previous.byId.has(id));

    if (survivingPrevious.length !== survivingNext.length) {
        return false;
    }

    return survivingPrevious.every((id, index) => survivingNext[index] === id);
};

/** An `_id`-indexed row set: the lookup map plus the preserved insertion order. */
type RowIndex = { byId: Map<string, Record<string, unknown>>; order: string[] };

/** A diff delta paired with its pre-serialized `delta` frame body (`JSON.stringify(delta)`). */
type FramedDelta = { delta: MutationDelta; frame: string };

/**
 * Collect `delete` deltas for every prev row absent from `next`, in prev order.
 * Each delete's `frame` is byte-identical to `JSON.stringify({key, op, table})`.
 */
const collectDeleteDeltas = (previous: RowIndex, next: RowIndex, deltaTable: string, tableJson: string): FramedDelta[] => {
    const out: FramedDelta[] = [];

    for (const id of previous.order) {
        if (!next.byId.has(id)) {
            out.push({
                delta: { key: id, op: "delete", table: deltaTable },
                frame: `{"key":${JSON.stringify(id)},"op":"delete","table":${tableJson}}`,
            });
        }
    }

    return out;
};

/**
 * Collect `insert`/`update` deltas for every next row that is new or whose body
 * changed, in next order. Each next row is fingerprinted with a SINGLE
 * `JSON.stringify` (finding #6) reused for both the `prev !== next` compare and
 * the `row` slot of the frame; each prev row is fingerprinted once too. Frames
 * are byte-identical to `JSON.stringify({key, op, row, table})`.
 */
const collectUpsertDeltas = (previous: RowIndex, next: RowIndex, deltaTable: string, tableJson: string): FramedDelta[] => {
    const out: FramedDelta[] = [];

    for (const id of next.order) {
        const nextRow = next.byId.get(id) as Record<string, unknown>;
        const previousRow = previous.byId.get(id);
        // `nextRow` is the raw query row (may hold `bigint`/`ArrayBuffer`), so
        // wire-encode it before fingerprinting/framing — `JSON.stringify` alone
        // throws on a bigint and drops a buffer to `{}`. `previousRow` comes from
        // the already-encoded baseline (see the `data`-frame `json`), so it is NOT
        // re-encoded. For a pure-JSON row `encodeWire` is structurally identical,
        // so the fingerprint compare and the frame stay byte-identical.
        const nextFingerprint = JSON.stringify(encodeWire(nextRow));
        const previousFingerprint = previousRow === undefined ? undefined : JSON.stringify(previousRow);

        if (previousFingerprint === nextFingerprint) {
            continue;
        }

        const op = previousFingerprint === undefined ? "insert" : "update";

        out.push({
            delta: { key: id, op, row: nextRow, table: deltaTable },
            frame: `{"key":${JSON.stringify(id)},"op":"${op}","row":${nextFingerprint},"table":${tableJson}}`,
        });
    }

    return out;
};

/**
 * Diff the previously-sent list snapshot (`previousJson`, the memo's
 * `lastJson`) against the new query result and produce per-row
 * {@link MutationDelta}s the client can merge in place via `applyDelta` —
 * Convex-parity live-pagination deltas (server half of gap #20).
 *
 * Returns `undefined` (caller falls back to a full `{type:"data"}` snapshot)
 * unless ALL of these hold:
 *
 * 1. `previousJson` parses to an array (there IS a previous list to diff against).
 * 2. `nextResult` is also an array.
 * 3. Every row in both arrays is a plain object carrying a string `_id`.
 * 4. Order preservation — rows present in BOTH arrays appear in the same relative order.
 * 5. Chattiness cap — the number of deltas does not exceed the new array length (a near-total change is cheaper as a snapshot).
 *
 * Diff is keyed by `_id`: rows only in prev → `delete`; rows only in next →
 * `insert`; rows in both whose JSON differs → `update`. Insert/update carry the
 * full new `row`; delete omits it (matching the wire contract `@lunora/client`
 * parses). Deltas are ordered deletes-then-inserts/updates so the client never
 * sees a transient over-length page.
 *
 * Per-row serialization is done exactly **once** per refresh (finding #6). Each
 * row is stringified a single time into a fingerprint reused for both the
 * `prev !== next` change-detection compare and — when the caller passes the
 * optional `frames` sink — the pre-serialized delta frame body. The returned
 * `MutationDelta[]` shape is unchanged; `frames`, when supplied, receives the
 * exact `JSON.stringify(delta)` string for each returned delta, in the same
 * order, so the caller can splice it straight into the `{type:"delta"}` frame
 * without serializing the delta (and the row inside it) a second time.
 * @returns the per-row deltas to send, or `undefined` when any precondition fails and a full snapshot should be sent instead
 */
const subscriptionListDeltas = (previousJson: string, nextResult: unknown, table: string, frames?: string[]): MutationDelta[] | undefined => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(previousJson);
    } catch {
        return undefined;
    }

    // (1) + (2): both sides must be arrays. (3): both must be id-keyable.
    if (!Array.isArray(parsed) || !Array.isArray(nextResult)) {
        return undefined;
    }

    const previous = indexRowsById(parsed);
    const next = indexRowsById(nextResult);

    if (previous === undefined || next === undefined) {
        return undefined;
    }

    // (4): survivors keep their relative order.
    if (!survivorsKeepOrder(previous, next)) {
        return undefined;
    }

    const deltaTable = table === "" ? DELTA_FALLBACK_TABLE : table;
    const tableJson = JSON.stringify(deltaTable);
    // Deletes precede upserts so the client never sees a transient over-length page.
    const framed = [...collectDeleteDeltas(previous, next, deltaTable, tableJson), ...collectUpsertDeltas(previous, next, deltaTable, tableJson)];

    // (5): a near-total change is better sent as a single snapshot.
    if (framed.length > next.order.length) {
        return undefined;
    }

    if (frames !== undefined) {
        for (const { frame } of framed) {
            frames.push(frame);
        }
    }

    return framed.map(({ delta }) => delta);
};

/**
 * Send one WebSocket frame, reporting whether it left the socket. A throw from
 * `ws.send` (socket closed mid-flush, outbound buffer gone) is the only
 * delivery-failure signal the runtime exposes; callers use the boolean to decide
 * whether to advance a subscription's delivered-diff baseline.
 */
const trySendFrame = (ws: WebSocket, frame: string): boolean => {
    try {
        ws.send(frame);

        return true;
    } catch {
        return false;
    }
};

/**
 * Send every delta frame for one subscription. Reports `delivered` only when ALL
 * frames left the socket: a partial failure must keep the diff baseline at the
 * last fully-delivered value so the next flush re-diffs the whole change. Keyed
 * list deltas are idempotent on replay, so re-sending an already-applied row is
 * harmless.
 */
const sendDeltaFrames = (ws: WebSocket, subId: string, deltaFrames: ReadonlyArray<string>, cursorSuffix: string): boolean => {
    const idJson = JSON.stringify(subId);
    let delivered = true;

    for (const deltaBody of deltaFrames) {
        if (!trySendFrame(ws, `{"type":"delta","id":${idJson},"delta":${deltaBody}${cursorSuffix}}`)) {
            delivered = false;
        }
    }

    return delivered;
};

/**
 * Defensive WS backpressure helper. When the runtime exposes `bufferedAmount`
 * on the socket, pause iteration whenever the outbound buffer is past 1 MiB;
 * otherwise treat the socket as drained. Capped at 100 sleeps of 20 ms (≈ 2 s
 * total) so a permanently-stuck buffer can't pin the iterator forever — past
 * that we drop through and let the next `ws.send` surface the failure.
 */
const awaitWsDrain = async (ws: WebSocket): Promise<void> => {
    let attempts = 0;

    while (attempts < 100) {
        attempts += 1;

        const buffered = (ws as { bufferedAmount?: unknown }).bufferedAmount;

        if (typeof buffered !== "number" || buffered < 1_048_576) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- intentional backpressure poll: sleep, then re-check the drained buffer on the next iteration
        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });
    }
};

export { awaitWsDrain, sendDeltaFrames, subscriptionListDeltas, trySendFrame };
