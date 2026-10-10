import type { LunoraErrorCode } from "@lunora/errors";
import { LunoraError } from "@lunora/errors";

import { decodeWire } from "../../../shared/wire-codec";
import { getRetryAfterMs, TransportError } from "./errors";
import type { SubscriptionError } from "./subscription";
import type { ServerErrorMessage } from "./types";

/**
 * Parse a `Retry-After` header into milliseconds. RFC 9110 defines TWO forms and
 * a proxy in front of the worker sends the one the runtime's own REST limiter
 * never does: `delta-seconds`, or an HTTP-date.
 *
 * `undefined` when the header is absent, unparseable, or already in the past —
 * an unusable hint has to read as NO hint (the caller then backs off on its own),
 * never as `NaN`, which every downstream comparison silently answers `false` to
 * and which would ride into `data.retryAfterMs` for an app to render. A date is
 * only clamped at the bottom here; the top is `replayRetryDelayMs`'s job,
 * which bounds both forms alike so an absurd date cannot strand the queue.
 */
const retryAfterHeaderMs = (header: null | string): number | undefined => {
    if (header === null) {
        return undefined;
    }

    const seconds = Number(header);

    if (Number.isFinite(seconds)) {
        return seconds > 0 ? seconds * 1000 : undefined;
    }

    const at = Date.parse(header);

    if (Number.isNaN(at)) {
        return undefined;
    }

    const delta = at - Date.now();

    return delta > 0 ? delta : undefined;
};

/**
 * The `data` an error should carry once a `Retry-After` response header is
 * folded in as `data.retryAfterMs` — the ONE channel a retry hint travels on.
 * `undefined` when the header adds nothing, so the caller leaves the error
 * untouched.
 *
 * The runtime's REST limiter sends whole seconds in the header where an
 * application limiter puts milliseconds in the error envelope's `data`. This
 * normalises the header form into the envelope form at the response boundary, so
 * `data.retryAfterMs` is the only place anything downstream has to look —
 * including `@lunora/client`'s public {@link getRetryAfterMs}, which an app calls
 * to render "try again in N seconds" and which never saw the header form.
 *
 * An envelope hint the server actually sent wins: it is the limiter's own
 * number, where the header is rounded to whole seconds. A non-object `data` is
 * left alone rather than overwritten — losing an unusual payload is worse than
 * losing a hint.
 */
const retryAfterData = (error: { data?: unknown }, header: null | string): Record<string, unknown> | undefined => {
    const hint = retryAfterHeaderMs(header);

    if (hint === undefined || getRetryAfterMs(error) !== undefined) {
        return undefined;
    }

    if (error.data === undefined) {
        return { retryAfterMs: hint };
    }

    return typeof error.data === "object" && error.data !== null && !Array.isArray(error.data)
        ? { ...(error.data as Record<string, unknown>), retryAfterMs: hint }
        : undefined;
};

/**
 * The `{ code, message, data?, … }` envelope a response carries, or `undefined`
 * when it carries none.
 *
 * `protocol/README.md` §4.2: only an OBJECT in the `error` slot is an envelope.
 * A proxy's `{"error": "bad gateway"}` page, a `{"error": null}`, an array — the
 * key is present and there is no verdict in it, so the response is classified by
 * HTTP status like a body with no `error` key at all (`unparseableResponseError`), never read as one.
 *
 * That matters past the crash an unchecked read produces: an uncoded `Error` is
 * what `LunoraClient.settleWholeBatchError` rejects a whole chunk of durable
 * writes on, where the same response classified as transport re-queues them. All
 * eight `sdks/*` ports narrow the slot this way and are held to
 * `responseTransportError` in `protocol/fixtures/rpc.json`; so is this one.
 */
const errorEnvelopeOf = (body: unknown): { code?: string; data?: unknown; docsUrl?: string; hint?: string | string[]; message?: string } | undefined => {
    const slot = (body as RpcEnvelopeBody | null | undefined)?.error;

    return typeof slot === "object" && slot !== null && !Array.isArray(slot) ? slot : undefined;
};

/**
 * The failure a BATCH SLOT whose `error` slot holds no envelope arrives as.
 *
 * A slot carries no HTTP status of its own, so there is no
 * `unparseableResponseError` verdict to reach for: nothing readable came
 * back about this entry, which is the same position as a slot the server never
 * returned at all, and §4.3 retries that one. A {@link TransportError} is how
 * the replay classifier spells "no verdict, keep the write".
 */
const unreadableSlotError = (): TransportError => new TransportError("LunoraClient: batch slot carried no error envelope");

/**
 * A §4.2 / §4.3 response body as it ARRIVES — every slot optional, and `error`
 * `unknown`, because the sender is a peer and a proxy sits between.
 *
 * The exported `RpcResponseBody` is the union the protocol documents, and
 * `"error" in body` narrows it — which is exactly how seven read sites came to
 * hand a slot no one had checked was an object to `reconstructError`.
 */
type RpcEnvelopeBody = { commitCursor?: number; error?: unknown; lastMutationId?: number; result?: unknown };

/**
 * Pull the `code`/`message` off a server `error` frame — either the top-level
 * fields or the nested `error` envelope (the server uses both shapes) — falling
 * back to `fallbackMessage` when neither carries a usable message.
 */
const parseServerError = (message: ServerErrorMessage, fallbackMessage: string): { code: string | undefined; messageText: string } => {
    const errorEnvelope = message.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof errorEnvelope?.code === "string" ? errorEnvelope.code : undefined;
    const nestedMessage = typeof errorEnvelope?.message === "string" ? errorEnvelope.message : undefined;

    return { code, messageText: (typeof message.message === "string" ? message.message : undefined) ?? nestedMessage ?? fallbackMessage };
};

/** Build a coded `Error` from a stream-scoped server `error` frame. */
const buildStreamError = (message: ServerErrorMessage): Error => {
    const { code, messageText } = parseServerError(message, "stream error");

    return code === undefined ? new Error(messageText) : new LunoraError(code, messageText);
};

/**
 * Build a `SubscriptionError` from a subscription-scoped server `error`
 * frame, so an `onError` consumer can branch on a coded rejection instead of
 * only seeing the human message.
 */
const buildSubscriptionError = (message: ServerErrorMessage): SubscriptionError => {
    const { code, messageText } = parseServerError(message, "subscription error");

    return { message: messageText, ...(code === undefined ? {} : { code }) };
};

/** Rebuild a thrown `Error` from a server `{ code, message, data?, hint?, docsUrl? }` envelope, wire-decoding `data` so `bigint`/`bytes` inside it survive. */
const reconstructError = (errorBody: { code?: string; data?: unknown; docsUrl?: string; hint?: string | string[]; message?: string }): LunoraClientError => {
    const error = new Error(errorBody.message ?? "request failed") as LunoraClientError;

    error.code = errorBody.code;

    // Guarded: a `data` the codec refuses is dropped, and the envelope stays the
    // server's coded verdict. Thrown bare, the codec's own exception replaced the
    // coded error — codeless, so a replay classified it as transport and re-sent
    // the write forever, and inside a batch demux it abandoned every later slot.
    if (errorBody.data !== undefined) {
        try {
            error.data = decodeWire(errorBody.data);
        } catch {
            // Dropped: see above.
        }
    }

    if (errorBody.hint !== undefined) {
        error.hint = errorBody.hint;
    }

    if (errorBody.docsUrl !== undefined) {
        error.docsUrl = errorBody.docsUrl;
    }

    return error;
};

/**
 * Rebuild a thrown `Error` from a server `{ error }` envelope (`reconstructError`)
 * with any `Retry-After` response header folded into `data.retryAfterMs` — the ONE
 * channel a retry hint travels on, and the only one the public `getRetryAfterMs`
 * reads. The runtime's REST limiter sends its hint as the header (whole seconds)
 * where an application limiter puts milliseconds in the envelope, so both replay
 * paths normalise it here rather than each in their own way.
 */
const reconstructErrorWithRetryAfter = (
    errorBody: { code?: string; data?: unknown; docsUrl?: string; hint?: string | string[]; message?: string },
    retryAfterHeader: null | string,
): LunoraClientError => {
    const error = reconstructError(errorBody);
    const data = retryAfterData(error, retryAfterHeader);

    if (data !== undefined) {
        error.data = data;
    }

    return error;
};

/**
 * The error a replayed batch slot carrying an `{ error }` body settles or
 * re-queues on: the envelope it carries, or `unreadableSlotError` when the
 * slot holds no envelope to read a verdict out of (§4.2).
 */
const slotError = (inner: { error?: unknown }): LunoraClientError => {
    const envelope = errorEnvelopeOf(inner);

    // The cast spans one slot: `@lunora/errors` types `hint` as a READONLY
    // string array and this module's public `LunoraClientError` as a mutable
    // one. A `TransportError` never sets it, so nothing crosses the gap.
    return envelope === undefined ? (unreadableSlotError() as LunoraClientError) : reconstructError(envelope);
};

/**
 * An `Error` carrying the server's machine-readable `code` and (for a
 * `LunoraError`) structured `data`, plus an optional actionable `hint` (Markdown)
 * and `docsUrl` resolved from the central error catalog. The client's public
 * error contract for RPC/batch failures — a UI can render `hint`/`docsUrl` to
 * tell the user how to fix the error. The `(string & {})` arm keeps
 * forward-compat/unknown server codes assignable without losing autocomplete on
 * the known `LunoraErrorCode` union.
 */
type LunoraClientError = Error & { code?: LunoraErrorCode | (string & {}); data?: unknown; docsUrl?: string; hint?: string | string[] };

export {
    buildStreamError,
    buildSubscriptionError,
    errorEnvelopeOf,
    reconstructError,
    reconstructErrorWithRetryAfter,
    retryAfterData,
    retryAfterHeaderMs,
    slotError,
    unreadableSlotError,
};
export type { LunoraClientError, RpcEnvelopeBody };
