import type { LunoraErrorCode } from "@lunora/errors";
import { LunoraError } from "@lunora/errors";

import { decodeWire } from "../../../shared/wire-codec";
import { errorEnvelopeOf, retryAfterData, unreadableSlotError } from "./replay";
import type { SubscriptionError } from "./subscription";
import type { ServerErrorMessage } from "./types";

/**
 * Pull the `code`/`message` off a server `error` frame — either the top-level
 * fields or the nested `error` envelope (the server uses both shapes) — falling
 * back to `fallbackMessage` when neither carries a usable message.
 */
export const parseServerError = (message: ServerErrorMessage, fallbackMessage: string): { code: string | undefined; messageText: string } => {
    const errorEnvelope = message.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof errorEnvelope?.code === "string" ? errorEnvelope.code : undefined;
    const nestedMessage = typeof errorEnvelope?.message === "string" ? errorEnvelope.message : undefined;

    return { code, messageText: (typeof message.message === "string" ? message.message : undefined) ?? nestedMessage ?? fallbackMessage };
};

/** Build a coded `Error` from a stream-scoped server `error` frame. */
export const buildStreamError = (message: ServerErrorMessage): Error => {
    const { code, messageText } = parseServerError(message, "stream error");

    return code === undefined ? new Error(messageText) : new LunoraError(code, messageText);
};

/**
 * Build a `SubscriptionError` from a subscription-scoped server `error`
 * frame, so an `onError` consumer can branch on a coded rejection instead of
 * only seeing the human message.
 */
export const buildSubscriptionError = (message: ServerErrorMessage): SubscriptionError => {
    const { code, messageText } = parseServerError(message, "subscription error");

    return { message: messageText, ...(code === undefined ? {} : { code }) };
};

/** Rebuild a thrown `Error` from a server `{ code, message, data?, hint?, docsUrl? }` envelope, wire-decoding `data` so `bigint`/`bytes` inside it survive. */
export const reconstructError = (errorBody: {
    code?: string;
    data?: unknown;
    docsUrl?: string;
    hint?: string | string[];
    message?: string;
}): LunoraClientError => {
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
export const reconstructErrorWithRetryAfter = (
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
export const slotError = (inner: { error?: unknown }): LunoraClientError => {
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
export type LunoraClientError = Error & { code?: LunoraErrorCode | (string & {}); data?: unknown; docsUrl?: string; hint?: string | string[] };
