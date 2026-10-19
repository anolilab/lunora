/**
 * Shared, bundler-inlined contract for carrying a shard-side error's real
 * `name` / `message` / `stack` back to the worker that dispatched the RPC.
 *
 * The client-facing error body is redacted (an internal throw becomes
 * `"internal error"`, and no stack ever crosses), so without this the worker's
 * `onRpc` event only knew the status code. The detail rides on a response header
 * the worker reads and strips before the response leaves it, and the DO only
 * writes it when the worker's own request asked for it — every client-reachable
 * path strips inbound `x-lunora-*` headers, so a client cannot opt itself in.
 */

/** Request header (`"1"`) by which the worker asks the shard for {@link ERROR_DETAIL_HEADER}. */
export const WANT_ERROR_DETAIL_HEADER = "x-lunora-want-error-detail";

/** Response header carrying the URI-encoded JSON {@link ErrorDetail}. */
export const ERROR_DETAIL_HEADER = "x-lunora-error-detail";

/** Stack cap, so a deep recursion's trace cannot blow the response-header limit. */
const MAX_STACK_LENGTH = 8192;

/** The unredacted facts about a thrown value, for observability sinks only. */
export interface ErrorDetail {
    /** The `LunoraError` taxonomy code, when the thrown value carries one. */
    code?: string;
    /**
     * The operator-only `internal` context of a `LunoraError`, when it is JSON-safe.
     * Attached by the shard only on the detail header (see {@link describeInternal}),
     * never by {@link describeError}, so it cannot leak into a log-event `error`.
     */
    internal?: Record<string, unknown>;
    message: string;
    name: string;
    stack?: string;
}

/** Describe a thrown value. A non-`Error` throw has no stack. */
export const describeError = (error: unknown): ErrorDetail => {
    if (!(error instanceof Error)) {
        return { message: String(error), name: typeof error };
    }

    const { code } = error as { code?: unknown };

    return {
        ...(typeof code === "string" ? { code } : {}),
        message: error.message,
        name: error.name,
        ...(error.stack === undefined ? {} : { stack: error.stack.slice(0, MAX_STACK_LENGTH) }),
    };
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Encoded-size cap. The detail rides a response header and Cloudflare caps a
 * response's headers at 128 KiB in total, so an unbounded message (or a
 * non-ASCII one, which URI-encoding inflates up to 9×) would fail the very
 * response it describes.
 */
const MAX_ENCODED_LENGTH = 16_384;

/**
 * A `JSON.stringify` replacer that turns a nested `Error` into a record of its name, message and
 * enumerable fields. `JSON` alone would write it as `{}`, since both `message` and `name` are
 * non-enumerable, so every serialization of an operator context uses this.
 */
const plainErrorReplacer = (_key: string, value: unknown): unknown => (value instanceof Error ? { ...value, message: value.message, name: value.name } : value);

/**
 * The operator-only `internal` context of a thrown `Error` (a `LunoraError`'s), for the
 * detail header alone. `undefined` unless it is a plain object that survives
 * `JSON.stringify`: a bigint or a cycle would otherwise throw inside the header encode,
 * failing the very response the detail describes.
 */
export const describeInternal = (error: unknown): Record<string, unknown> | undefined => {
    if (!(error instanceof Error)) {
        return undefined;
    }

    try {
        const { internal } = error as { internal?: unknown };

        if (!isPlainRecord(internal)) {
            return undefined;
        }

        const json = JSON.stringify(internal, plainErrorReplacer);

        // Over the cap the header would drop this context anyway, since URI-encoding only
        // grows it. Refusing it here skips copying and encoding a large record twice.
        if (json.length > MAX_ENCODED_LENGTH) {
            return undefined;
        }

        // Return the JSON copy, not the original: a getter that answers differently on
        // a second read would pass this check and then throw in the header encode.
        // A `toJSON()` can serialize to a primitive, so the copy is checked again.
        const copy: unknown = JSON.parse(json);

        return isPlainRecord(copy) ? copy : undefined;
    } catch {
        return undefined;
    }
};

/**
 * A plain copy of an operator context for the sinks: nested `Error`s become records of their
 * name, message and enumerable fields. Credential redaction keys on field names and on text
 * inside strings, but it passes an `Error` through opaque, so its message would otherwise reach
 * a sink unredacted. `undefined` when the context cannot be encoded.
 */
export const toPlainOperatorContext = (internal: Record<string, unknown>): Record<string, unknown> | undefined => {
    try {
        const copy: unknown = JSON.parse(JSON.stringify(internal, plainErrorReplacer));

        return isPlainRecord(copy) ? copy : undefined;
    } catch {
        return undefined;
    }
};

/**
 * The first `Error` a `ctx.log.*` call was handed — as an argument
 * (`ctx.log.error("failed", err)`) or as a value of a fields bag
 * (`ctx.log.error("failed", { err })`) — described for a log event's `error`.
 */
export const findLoggedError = (args: readonly unknown[]): ErrorDetail | undefined => {
    for (const arg of args) {
        if (arg instanceof Error) {
            return describeError(arg);
        }

        if (typeof arg === "object" && arg !== null && !Array.isArray(arg)) {
            const nested = Object.values(arg).find((value) => value instanceof Error);

            if (nested !== undefined) {
                return describeError(nested);
            }
        }
    }

    return undefined;
};

/** How much of the message survives when the full detail is over the cap. */
const TRUNCATED_MESSAGE_LENGTH = 1024;

/**
 * Header-safe (ASCII) encoding of an {@link ErrorDetail}, at most
 * {@link MAX_ENCODED_LENGTH} characters: over it, `internal` is dropped first (it is the
 * optional part), then the stack and `internal` together with the message and name
 * truncated, which always fits.
 */
export const encodeErrorDetail = (detail: ErrorDetail): string => {
    const encoded = encodeURIComponent(JSON.stringify(detail));

    if (encoded.length <= MAX_ENCODED_LENGTH) {
        return encoded;
    }

    if (detail.internal !== undefined) {
        const withoutInternal = encodeURIComponent(JSON.stringify({ ...detail, internal: undefined }));

        if (withoutInternal.length <= MAX_ENCODED_LENGTH) {
            return withoutInternal;
        }
    }

    return encodeURIComponent(
        JSON.stringify({
            ...(detail.code === undefined ? {} : { code: detail.code.slice(0, 128) }),
            message: detail.message.slice(0, TRUNCATED_MESSAGE_LENGTH),
            name: detail.name.slice(0, 128),
        }),
    );
};

/** Decode {@link encodeErrorDetail}'s output; `undefined` for an absent or malformed value. */
export const decodeErrorDetail = (value: null | string | undefined): ErrorDetail | undefined => {
    if (value === null || value === undefined) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(decodeURIComponent(value)) as Partial<ErrorDetail> | null;

        if (typeof parsed?.message !== "string" || typeof parsed.name !== "string") {
            return undefined;
        }

        // A non-object `internal` is malformed: drop it, keep the rest of the detail.
        const { internal, ...rest } = parsed as ErrorDetail;

        return isPlainRecord(internal) ? { ...rest, internal } : rest;
    } catch {
        return undefined;
    }
};
