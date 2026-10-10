import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { LunoraClientError } from "./wire-errors";
import { slotError } from "./wire-errors";

/**
 * Wire-encode a call's `args`/payload, tagging an encode failure with the call it
 * came from. The bare codec error ("wire-codec: cannot encode a RegExp …") names
 * the type but not the operation — which is useless on the fire-and-forget whisper
 * path and the async outbox flush, where the throw has no call-site stack. Prefixing
 * with `label` (e.g. `args for 'messages:send'`) turns it into an actionable message
 * while preserving the original via `cause`.
 *
 * The client's broader-payload sibling of `shared/wire-codec.ts`'s
 * `encodeArgsOrThrow`, which the call-envelope producers share: this one also
 * labels a whisper payload and a shape's args, neither of which is a function's
 * `args`, so it keeps its own free-form `label`.
 */
const encodeCallArgs = (payload: unknown, label: string): unknown => {
    try {
        return encodeWire(payload);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        throw new TypeError(`LunoraClient: cannot encode ${label} — ${reason}`, error instanceof Error ? { cause: error } : undefined);
    }
};

/** Whether `payload` survives the wire codec; its failure is a `TypeError`, like a network failure. */
const isEncodable = (payload: unknown): boolean => {
    try {
        encodeWire(payload);

        return true;
    } catch {
        return false;
    }
};

/**
 * Whether a slot body is a readable `{ result }` / `{ error }` envelope (§4.2).
 * A `null`, a non-object, or an object carrying neither key is not one, and
 * reading `"error" in body` on the first of those throws.
 */
const isSlotEnvelope = (body: unknown): body is { error?: unknown; result?: unknown } =>
    body !== null && typeof body === "object" && ("error" in body || "result" in body);

/**
 * Demux a `/_lunora/rpc-batch` response into per-call slots in input order,
 * wire-decoding each success value and reconstructing `.code`/`.data` on a
 * failing call. A slot the server never returned surfaces as an error rather
 * than a silent `undefined` success.
 *
 * So does a slot whose `error` key holds no readable envelope: it used to read
 * as a MISSING error (`{ error: null }` is falsy) and be handed back as
 * `{ ok: true, value: undefined }` — a failed call reported to the caller as a
 * committed one.
 */
const demuxBatchResults = (rawResults: { body?: unknown; id?: number }[], count: number): BatchSlot[] => {
    const slots = Array.from<BatchSlot | undefined>({ length: count });

    for (const entry of rawResults) {
        if (typeof entry.id !== "number" || entry.id < 0 || entry.id >= count) {
            continue;
        }

        // A body that is not a readable envelope is not a verdict on the call, so it
        // fails the slot instead of throwing and abandoning every later slot.
        if (!isSlotEnvelope(entry.body)) {
            slots[entry.id] = { error: slotError({}), ok: false };
            continue;
        }

        const inner = entry.body;

        slots[entry.id] = "error" in inner ? { error: slotError(inner), ok: false } : { ok: true, value: decodeWire(inner.result) };
    }

    return slots.map((slot) => slot ?? { error: new Error("batch call returned no result"), ok: false });
};

/**
 * The `expectSubject` a replayed write carries: the user its identity stamp
 * names, so the worker refuses it when the request resolves to anyone else.
 *
 * The replay gate compares the stamp with what this client believes, and
 * under a cookie session that belief can be stale — a sign-out and another
 * user's sign-in change no token, and the socket's `open` flush runs before
 * its `identity` frame lands. Only the server sees the cookie the write is
 * about to ride, so it is the server that has to check.
 *
 * Sent on every replay made without a bearer token, whatever resolved the
 * stamp — a socket's `identity` frame labels the session in apps that never
 * call `getCurrentUser()` too. An app without auth stamps `null` and its
 * requests resolve to nobody, so the header always passes there. A bearer
 * request (`authToken`, the one the request is sent with) states its
 * credential explicitly and the gate already matched it; a token-hash or
 * missing stamp names no user.
 */
const replayExpectation = (stamp: null | string | undefined, authToken: null | string): { expectSubject?: null | string } => {
    if (authToken !== null) {
        return {};
    }

    if (stamp === null) {
        // eslint-disable-next-line unicorn/no-null -- queued while signed out
        return { expectSubject: null };
    }

    return stamp?.startsWith("subj:") === true ? { expectSubject: stamp.slice("subj:".length) } : {};
};
/** One demuxed result slot of a `LunoraClient.batch` call. */
type BatchSlot = { error: LunoraClientError; ok: false } | { ok: true; value: unknown };

export { demuxBatchResults, encodeCallArgs, isEncodable, isSlotEnvelope, replayExpectation };

export type { BatchSlot };
