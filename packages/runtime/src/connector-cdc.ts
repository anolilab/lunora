/**
 * Pure CDC-connector helpers, extracted from `create-worker.ts`. These back the
 * turn-key warehouse-connector sync endpoint (`/_cirrus/admin/connector/sync`):
 * the opaque cursor codec (a base64url token wrapping the per-shard + global CDC
 * positions) and the change-folding that flattens each source's raw CDC page into
 * the connector wire shape. All functions here are pure — no worker options, no
 * I/O — so they live free of `create-worker` and are unit-testable in isolation.
 */
import type { ConnectorChange } from "./connector-format";

/** Reusable encoder for the cursor codec (base64url over the JSON state). */
const CURSOR_ENCODER = new TextEncoder();

/**
 * Decoded shape of the connector sync endpoint's opaque cursor token. Encodes
 * the per-shard CDC cursor map plus the global (D1) cursor behind a single
 * base64url string so a warehouse connector treats the whole multi-source
 * position as one black-box `state` value (the contract Fivetran/Airbyte expect).
 */
interface ConnectorCursorState {
    /** Global (D1) CDC `seq` last read through. */
    g: number;
    /** Per-shard CDC `seq` last read through, keyed by shard key. */
    s: Record<string, number>;
    /** Token format version, so the shape can evolve without breaking old cursors. */
    v: 1;
}

/**
 * Encode a {@link ConnectorCursorState} as an opaque base64url token. The
 * consumer stores it verbatim and re-posts it to resume — it never parses it,
 * so the internal shape stays free to change behind the version tag.
 */
const encodeConnectorCursor = (state: ConnectorCursorState): string => {
    const json = JSON.stringify(state);
    const bytes = CURSOR_ENCODER.encode(json);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/**
 * Decode an opaque connector cursor token back to its {@link ConnectorCursorState}.
 * A missing / empty / malformed token decodes to the zero state (sync from the
 * beginning) so a fresh consumer can omit the cursor and a corrupt one can't
 * crash the endpoint — the worst case is a full re-sync, which is safe (upsert).
 */
const decodeConnectorCursor = (token: unknown): ConnectorCursorState => {
    const empty: ConnectorCursorState = { g: 0, s: {}, v: 1 };

    if (typeof token !== "string" || token.length === 0) {
        return empty;
    }

    try {
        const binary = atob(token.replaceAll("-", "+").replaceAll("_", "/"));
        const bytes = new Uint8Array(binary.length);

        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.codePointAt(index) ?? 0;
        }

        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ConnectorCursorState>;
        const shards = parsed.s && typeof parsed.s === "object" ? parsed.s : {};
        const sanitized: Record<string, number> = {};

        for (const [key, value] of Object.entries(shards)) {
            if (typeof value === "number" && Number.isFinite(value)) {
                sanitized[key] = value;
            }
        }

        return { g: typeof parsed.g === "number" && Number.isFinite(parsed.g) ? parsed.g : 0, s: sanitized, v: 1 };
    } catch {
        return empty;
    }
};

/**
 * Flatten one raw CDC change record (the `{ id, op, seq, table, ts, doc? }` shape
 * both the shard and D1 change feeds emit) into a {@link ConnectorChange} the
 * connector-format helpers consume. A delete carries no post-image `doc`, so the
 * row is reduced to its primary key (`_id`) from the change's `id`; an unknown
 * `op` collapses to `"upsert"`.
 */
const flattenCdcChange = (change: Record<string, unknown>): ConnectorChange => {
    const table = typeof change["table"] === "string" ? change["table"] : "";
    const rawOp = typeof change["op"] === "string" ? change["op"] : "";
    const op: ConnectorChange["op"] = rawOp === "delete" || rawOp === "insert" || rawOp === "update" ? rawOp : "upsert";
    const id = typeof change["id"] === "string" ? change["id"] : undefined;
    const postImage = change["doc"] && typeof change["doc"] === "object" ? (change["doc"] as Record<string, unknown>) : undefined;
    // A delete has no post-image; surface the primary key so the consumer can
    // tombstone the row. Insert/update carry the full post-image.
    const documentRow: Record<string, unknown> = postImage ?? (id === undefined ? {} : { _id: id });

    return { doc: documentRow, op, table };
};

/**
 * Fold one source's CDC page (a shard's or the global plane's) into the
 * accumulating connector page: flatten its changes onto `changes` and report
 * whether it filled the requested `limit` (a full page signals more rows likely
 * remain past this cursor). Pure routing — the caller owns cursor bookkeeping.
 */
const foldCdcPage = (changes: ConnectorChange[], pageChanges: ReadonlyArray<Record<string, unknown>>, limit: number | undefined): boolean => {
    for (const change of pageChanges) {
        changes.push(flattenCdcChange(change));
    }

    return limit !== undefined && pageChanges.length >= limit;
};

export type { ConnectorCursorState };
export { decodeConnectorCursor, encodeConnectorCursor, flattenCdcChange, foldCdcPage };
