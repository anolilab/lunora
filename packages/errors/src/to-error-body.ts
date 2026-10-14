/**
 * The single builder for the client-facing error envelope body — the one place
 * the wire redaction posture lives. Every transport edge (the runtime HTTP
 * mapper, the Durable Object RPC mapper, the WS/SSE streaming frames, and the
 * shape-subscription frames) calls this so the invariant "an internal-coded or
 * unrecognized error never echoes its message" holds identically everywhere,
 * instead of being re-derived (and drifting) per edge.
 */
import type { ErrorHint } from "./catalog";
import { isInternalCode, resolveHint } from "./catalog";
import { isLunoraError } from "./guards";

/** The client-facing error envelope body. */
export interface ErrorBody {
    code: string;
    data?: unknown;
    docsUrl?: string;
    hint?: ErrorHint;
    message: string;
}

export interface ToErrorBodyOptions {
    /**
     * Wire-encode a `LunoraError`'s structured `data` for the client (so a
     * `bigint`/`bytes` inside it survives). Omit to drop `data` from the body.
     */
    encodeData?: (data: unknown) => unknown;
    /** Code for an unrecognized (non-`LunoraError`) throw. Default `"INTERNAL"`. */
    fallbackCode?: string;
    /** Message sent when the error is redacted (internal-coded or unrecognized). Default `"Internal error"`. */
    redactedMessage?: string;
}

export interface ToErrorBodyResult {
    body: ErrorBody;
    /** True when the message was redacted — the caller should log the raw error server-side. */
    redacted: boolean;
    /** HTTP/RPC status. */
    status: number;
}

/**
 * Turn a thrown value into an {@link ErrorBody} + status, applying the redaction
 * invariant. A `LunoraError` with a non-internal code is echoed with its
 * `message`, resolved `hint`, `docsUrl`, and (when `encodeData` is given) its
 * `data`. An internal-coded `LunoraError` keeps its `code`/`status` but its
 * message is replaced with `redactedMessage`. Anything else becomes a generic
 * `fallbackCode`/500. When `redacted` is `true`, log the raw error server-side.
 */
export const toErrorBody = (error: unknown, options: ToErrorBodyOptions = {}): ToErrorBodyResult => {
    const redactedMessage = options.redactedMessage ?? "Internal error";

    if (isLunoraError(error)) {
        if (isInternalCode(error.code)) {
            return { body: { code: error.code, message: redactedMessage }, redacted: true, status: error.status };
        }

        const body: ErrorBody = { code: error.code, message: error.message };

        if (error.data !== undefined && options.encodeData !== undefined) {
            body.data = options.encodeData(error.data);
        }

        const hint = resolveHint({ code: error.code, hint: error.hint, message: error.message });

        if (hint !== undefined) {
            body.hint = hint;
        }

        if (error.docsUrl !== undefined) {
            body.docsUrl = error.docsUrl;
        }

        return { body, redacted: false, status: error.status };
    }

    return { body: { code: options.fallbackCode ?? "INTERNAL", message: redactedMessage }, redacted: true, status: 500 };
};
