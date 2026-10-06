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

/** Header-safe (ASCII) encoding of an {@link ErrorDetail}. */
export const encodeErrorDetail = (detail: ErrorDetail): string => encodeURIComponent(JSON.stringify(detail));

/** Decode {@link encodeErrorDetail}'s output; `undefined` for an absent or malformed value. */
export const decodeErrorDetail = (value: null | string | undefined): ErrorDetail | undefined => {
    if (value === null || value === undefined) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(decodeURIComponent(value)) as Partial<ErrorDetail> | null;

        return typeof parsed?.message === "string" && typeof parsed.name === "string" ? (parsed as ErrorDetail) : undefined;
    } catch {
        return undefined;
    }
};
