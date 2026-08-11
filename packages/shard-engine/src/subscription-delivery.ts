/**
 * Subscription wire-delivery for the DO store: the keyed list-diff encoder
 * (`subscriptionListDeltas` + its row-indexing helpers), the frame renderer that
 * chooses between deltas and a snapshot (`subscriptionFrames`), and the
 * best-effort sender (`trySendFrame`).
 *
 * Extracted from `shard-do.ts` as a cohesive unit — these are pure functions
 * with no `this`/instance state: they turn a previous-vs-next query result into
 * the frames a client merges in place, and push them onto a hibernatable
 * `WebSocket`, reporting whether each frame left the socket so the caller can
 * protect its diff baseline. `shard-do.ts` imports these and re-exports
 * `subscriptionListDeltas` so existing import sites (the index barrel, tests)
 * are unchanged.
 */

import { stableStringify } from "../../../shared/stable-key";
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

/** An `_id`-indexed row set: the lookup map plus the preserved insertion order. */
type RowIndex = { byId: Map<string, Record<string, unknown>>; order: string[] };

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
const indexRowsById = (rows: unknown[]): RowIndex | undefined => {
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
const survivorsKeepOrder = (previous: RowIndex, next: RowIndex): boolean => {
    const survivingPrevious = previous.order.filter((id) => next.byId.has(id));
    const survivingNext = next.order.filter((id) => previous.byId.has(id));

    if (survivingPrevious.length !== survivingNext.length) {
        return false;
    }

    return survivingPrevious.every((id, index) => survivingNext[index] === id);
};

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

/** The row-array field a `.paginate()` result carries its page in. */
const PAGE_FIELD = "page";

/**
 * The `connect`-frame capability token a client sends to say it can merge a row
 * delta into the `page` of a `{ page, isDone, continueCursor }` result.
 *
 * Opt-in, and it has to be: an unmergeable delta is not ignored by a client that
 * predates this — `applyDelta` bails and the caller replaces the whole query
 * value with the raw delta object. A client that never announces this keeps
 * receiving snapshots, which is what every client did before and what the seven
 * non-JS SDKs still do (they send `connect` with no `caps` at all).
 */
const PAGE_DELTA_CAPABILITY = "pageDelta";

/** A plain (non-array, non-null) object — the shape a `.paginate()` result is. */
const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The row array to diff out of a query result, or `undefined` when the result
 * has no diffable list in it.
 *
 * Two accepted shapes:
 *
 * - the result IS the array (`ctx.db.query(...).collect()`);
 * - the result is `{ page: [...], … }` — what `.paginate()` yields, and
 * therefore what every `usePaginatedQuery` page subscribes to.
 *
 * For the paginated shape the caller must also confirm the fields AROUND the
 * page are unchanged; see {@link paginationEnvelopeMatches}. A row-delta stream
 * can only describe rows, so a moved `continueCursor` or a flipped `isDone` has
 * no way to reach the client and must force the snapshot.
 * @returns the row array to diff, or `undefined` when the result carries none
 */
const rowsOf = (value: unknown): unknown[] | undefined => {
    if (Array.isArray(value)) {
        return value as unknown[];
    }

    if (isPlainRecord(value) && Array.isArray(value[PAGE_FIELD])) {
        return value[PAGE_FIELD] as unknown[];
    }

    return undefined;
};

/**
 * True when two paginated results agree on everything except their `page`.
 *
 * Both sides are compared in their WIRE form with keys sorted, so the check is
 * insensitive to property order (`previous` was parsed back out of the last
 * delivered frame; `next` is a fresh handler result) and treats a `bigint` or
 * `Date` cursor the same way the frame would. Non-paginated (bare array)
 * results have no envelope and trivially match.
 * @returns `true` when the two results differ only in their `page`
 */
const paginationEnvelopeMatches = (previous: unknown, next: unknown): boolean => {
    if (Array.isArray(previous) && Array.isArray(next)) {
        return true;
    }

    if (!isPlainRecord(previous) || !isPlainRecord(next)) {
        return false;
    }

    const withoutPage = (value: Record<string, unknown>): Record<string, unknown> =>
        Object.fromEntries(Object.entries(value).filter(([key]) => key !== PAGE_FIELD));

    // `previous` is already wire-encoded (it was parsed out of the delivered
    // frame); `next` is raw, so it is encoded here — exactly the asymmetry the
    // per-row fingerprints use.
    return stableStringify(withoutPage(previous)) === stableStringify(encodeWire(withoutPage(next)));
};

/**
 * Diff the previously-sent list snapshot against the new query result, keyed by
 * `_id`, returning each changed row paired with its pre-serialized frame body.
 *
 * Returns `undefined` (the value is not expressible as row deltas at all)
 * unless ALL of these hold:
 *
 * 1. `previousJson` parses to a diffable list — an array, or a `{ page: [...] }` result (see {@link rowsOf}).
 * 2. `nextResult` carries a list of the same kind, and (when paginated) an identical envelope around it.
 * 3. Every row in both lists is a plain object carrying a string `_id`.
 * 4. Order preservation — rows present in BOTH lists appear in the same relative order.
 *
 * These are EXPRESSIBILITY conditions only. Whether the deltas are the cheaper
 * thing to put on the wire is a separate question, answered by
 * {@link subscriptionFrames} against the frames it is about to send — see the
 * note there on why no row-count proxy stands in for it.
 *
 * Diff is keyed by `_id`: rows only in prev → `delete`; rows only in next →
 * `insert`; rows in both whose JSON differs → `update`. Insert/update carry the
 * full new `row`; delete omits it (matching the wire contract `@lunora/client`
 * parses). Deltas are ordered deletes-then-inserts/updates so the client never
 * sees a transient over-length page.
 *
 * Per-row serialization is done exactly **once** per refresh (finding #6): each
 * row is stringified a single time into a fingerprint reused for both the
 * `prev !== next` change-detection compare and the frame body.
 * @returns the changed rows with their frame bodies, or `undefined` when the change is not expressible as row deltas
 */
const collectFramedDeltas = (previousJson: string, nextResult: unknown, table: string): FramedDelta[] | undefined => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(previousJson);
    } catch {
        return undefined;
    }

    // (1) + (2): both sides must carry a diffable list, of the same kind, and a
    // paginated pair must agree on everything outside the page.
    const previousRows = rowsOf(parsed);
    const nextRows = rowsOf(nextResult);

    if (previousRows === undefined || nextRows === undefined || Array.isArray(parsed) !== Array.isArray(nextResult)) {
        return undefined;
    }

    if (!paginationEnvelopeMatches(parsed, nextResult)) {
        return undefined;
    }

    // (3): both must be id-keyable.
    const previous = indexRowsById(previousRows);
    const next = indexRowsById(nextRows);

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
    return [...collectDeleteDeltas(previous, next, deltaTable, tableJson), ...collectUpsertDeltas(previous, next, deltaTable, tableJson)];
};

/**
 * The per-row {@link MutationDelta}s a change decomposes into, or `undefined`
 * when it is not expressible as row deltas — see {@link collectFramedDeltas}
 * for the four conditions.
 *
 * This is the diff as a VALUE, for callers that want to inspect it (and for the
 * unit tests that pin the diff's semantics). The delivery path does not use it:
 * {@link subscriptionFrames} needs the frame strings, not the delta objects, and
 * building both would allocate a `MutationDelta` per row per socket per
 * write-flush that nothing reads.
 *
 * `frames`, when supplied, receives the exact `JSON.stringify(delta)` string for
 * each returned delta, in the same order.
 * @returns the per-row deltas, or `undefined` when the change is not expressible as row deltas
 */
const subscriptionListDeltas = (previousJson: string, nextResult: unknown, table: string, frames?: string[]): MutationDelta[] | undefined => {
    const framed = collectFramedDeltas(previousJson, nextResult, table);

    if (framed === undefined) {
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
 * The minimal outbound surface these helpers need.
 *
 * Deliberately structural rather than `WebSocket`: a runtime socket and a
 * `SocketHandle` from `@lunora/platform` both satisfy it, so delivery code is
 * shared between the Cloudflare-native call sites and the host-contract ones
 * while the engine migrates from one to the other.
 */
interface FrameSink {
    send: (data: string) => void;
}

/**
 * A {@link FrameSink} that may report outbound backpressure. `bufferedAmount`
 * is optional because not every transport exposes it; absent means "assume
 * drained" (see {@link awaitWsDrain}).
 */
interface DrainableSink {
    readonly bufferedAmount?: unknown;
}

/**
 * Send one frame, reporting whether it left the socket. A throw from `send`
 * (socket closed mid-flush, outbound buffer gone) is the only delivery-failure
 * signal the runtime exposes; callers use the boolean to decide whether to
 * advance a subscription's delivered-diff baseline.
 */
const trySendFrame = (ws: FrameSink, frame: string): boolean => {
    try {
        ws.send(frame);

        return true;
    } catch {
        return false;
    }
};

/** Everything {@link subscriptionFrames} needs to render one subscription's frames. */
interface SubscriptionFrameInput {
    /** The trailing `,"cursor":<n>,"epoch":"<e>"` fragment, or `""` on a non-CDC shard. */
    cursorSuffix: string;
    /** This socket's custom-mutator watermark, stamped on every frame; omitted when the socket has none. */
    lastMutationId?: number;
    /** The fresh query result, unencoded — diffed row-wise against `previousJson`. */
    nextResult: unknown;

    /**
     * Whether this socket announced {@link PAGE_DELTA_CAPABILITY} on its
     * `connect` frame, i.e. whether it can merge a row delta into the `page` of
     * a `{ page, isDone, continueCursor }` result.
     *
     * Load-bearing, and fail-closed by default. A client that cannot do that
     * merge does not IGNORE a page delta — `@lunora/client`'s `applyDelta`
     * returns `undefined` for an unmergeable shape and the caller then replaces
     * the whole query value with the raw delta object. So sending page deltas
     * unconditionally would corrupt the value on every client that predates
     * this, including all seven non-JS SDKs. Absent means snapshots, which is
     * exactly the behaviour those clients have today.
     */
    pageDeltas?: boolean;
    /** The wire form of the value last DELIVERED for this subscription; `undefined` on a first send. */
    previousJson?: string;
    /** `JSON.stringify(encodeWire(nextResult))` — the exact `data` frame payload, built once by the caller. */
    snapshotJson: string;
    /** The subscription id the frames are addressed to. */
    subId: string;
    /** The table stamped on each delta; `""` falls back to {@link DELTA_FALLBACK_TABLE}. */
    table: string;
}

/**
 * Render the frames that carry one subscription's new value: either a run of
 * `{type:"delta"}` frames or the single `{type:"data"}` snapshot, whichever is
 * smaller on the wire.
 *
 * **Why the choice lives here.** Every delta frame re-pays the whole
 * `{"type":"delta","id":…}` + `"table":…` + cursor/epoch/watermark envelope
 * around ONE row body, which the snapshot pays once for the entire list. So the
 * deltas stop being the cheaper encoding well before they stop being a valid
 * one, and where that happens depends on the row size, the row count, and the
 * envelope width together. No row-count proxy ("no more deltas than rows") can
 * express that: it is blind to fat rows, to a wide envelope, and to a list of
 * tiny rows where a single delta already costs more than re-sending everything.
 * Rendering the frames first and summing their real lengths is exact, needs no
 * heuristic, and cannot drift from the format — because it IS the format. That
 * is also why the envelope is written in exactly one place (here) rather than
 * modelled a second time by the caller doing the sizing.
 *
 * Lengths are UTF-16 code units, not UTF-8 bytes. Both sides carry the same row
 * content, so a multi-byte payload inflates them together and the comparison
 * holds; it only shifts the crossover slightly toward the snapshot, which is the
 * safe direction (one frame is also one `ws.send` and one client apply). A tie
 * goes to the snapshot for the same reason.
 *
 * `lastMutationId` is stamped on EVERY frame, not just the last — a client's
 * checkpoint gate reads whichever frame it happens to observe, and re-stamping
 * the same value is a no-op for one that already saw an earlier one (idempotent,
 * monotonic `Math.max` on the read side). Without it a `@lunora/db` list
 * collection — the exact id-keyed shape the delta path targets, so every write
 * after its first snapshot goes out as deltas — would never see a frame-carried
 * watermark again (plan 266 finding d).
 *
 * A `{ page, … }` result is only ever diffed for a socket that announced
 * {@link PAGE_DELTA_CAPABILITY} — see {@link SubscriptionFrameInput.pageDeltas}
 * for why that gate is a correctness requirement and not a tuning knob.
 * @returns the frames to send in order; always at least one unless the diff found no changed rows
 */
const subscriptionFrames = (input: SubscriptionFrameInput): string[] => {
    const { cursorSuffix, lastMutationId, nextResult, pageDeltas, previousJson, snapshotJson, subId, table } = input;
    const idJson = JSON.stringify(subId);
    const suffix = (lastMutationId === undefined ? "" : `,"lastMutationId":${String(lastMutationId)}`) + cursorSuffix;
    const snapshot = `{"type":"data","id":${idJson},"data":${snapshotJson}${suffix}}`;
    // No baseline (first send, or the last send never left the socket) — there is
    // nothing to diff against, so the snapshot is the only option. A paginated
    // result is additionally gated on the socket having announced that it can
    // merge into `page`; without that the diff is never even attempted.
    const diffable = previousJson !== undefined && (pageDeltas === true || Array.isArray(nextResult));
    const framed = diffable ? collectFramedDeltas(previousJson, nextResult, table) : undefined;

    if (framed === undefined) {
        return [snapshot];
    }

    const deltas: string[] = [];
    let total = 0;

    for (const { frame } of framed) {
        const delta = `{"type":"delta","id":${idJson},"delta":${frame}${suffix}}`;

        total += delta.length;

        // The running total only grows, so once it reaches the snapshot the
        // snapshot has already won and the remaining envelopes would be built
        // only to be thrown away. Bailing here is not a different rule — it is
        // the same comparison, decided as early as it can be — and it matters
        // most in exactly the case this function exists to catch: a near-total
        // change, where otherwise every row allocates a frame that loses.
        if (total >= snapshot.length) {
            return [snapshot];
        }

        deltas.push(delta);
    }

    return deltas;
};

/**
 * Defensive WS backpressure helper. When the runtime exposes `bufferedAmount`
 * on the socket, pause iteration whenever the outbound buffer is past 1 MiB;
 * otherwise treat the socket as drained. Capped at 100 sleeps of 20 ms (≈ 2 s
 * total) so a permanently-stuck buffer can't pin the iterator forever — past
 * that we drop through and let the next `ws.send` surface the failure.
 */
const awaitWsDrain = async (ws: DrainableSink): Promise<void> => {
    let attempts = 0;

    while (attempts < 100) {
        attempts += 1;

        const { bufferedAmount: buffered } = ws;

        if (typeof buffered !== "number" || buffered < 1_048_576) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- intentional backpressure poll: sleep, then re-check the drained buffer on the next iteration
        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });
    }
};

export type { DrainableSink, FrameSink, SubscriptionFrameInput };
export { awaitWsDrain, PAGE_DELTA_CAPABILITY, subscriptionFrames, subscriptionListDeltas, trySendFrame };
