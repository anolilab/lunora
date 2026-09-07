/**
 * Client-side helpers over the machine-readable `code` the worker attaches to a
 * failed RPC/batch/subscription.
 *
 * The set of codes is DERIVED from `@lunora/errors`' `ERROR_CATALOG` — the one
 * registry every `LunoraError` is minted against — rather than hand-copied. The
 * hand-copied list this replaced had drifted to 12 of the ~60 registered codes,
 * and `getErrorCode` narrows through the set, so each omission (`VALIDATION_ERROR`,
 * the code a failed args validator throws, among them) read back as `undefined`
 * with nothing to notice it. `@lunora/errors` is zero-dependency and already in
 * the client's runtime graph (`LunoraError` itself reads the catalog), so this
 * costs no extra bundle.
 */
import type { LunoraErrorCode } from "@lunora/errors";
import { ERROR_CATALOG, LunoraError } from "@lunora/errors";

const KNOWN_ERROR_CODES = new Set<string>(Object.keys(ERROR_CATALOG));

/**
 * A failure the SERVER reached no verdict on: the response carried no
 * `{ error }` envelope at all — no `fetch` implementation, a non-JSON body from
 * a proxy, a bare 5xx gateway page.
 *
 * The distinction matters because a durable write must be re-queued rather than
 * dropped, and `code` cannot carry it: these arrive as `INTERNAL`, which is also
 * what a server that DID reach a verdict sends. It used to be a `Symbol` stamped
 * on with `Object.assign` and read back through a `Record<symbol, unknown>`
 * cast, so the one classifier that knew the convention was the only reader that
 * could ever see it. As a kind, every reader can: `error instanceof
 * TransportError`.
 *
 * Still `INTERNAL` on the wire, so nothing that switches on `code` changes.
 *
 * `data` carries the structured payload such an error can still have — the
 * `{ retryAfterMs }` a `Retry-After` on the unreadable response named, which
 * {@link getRetryAfterMs} reads back and the outbox paces its retry on.
 */
class TransportError extends LunoraError {
    public constructor(message: string, data?: unknown) {
        super("INTERNAL", message, { data });
    }
}

/** Error code the server uses for optimistic-concurrency conflicts (HTTP 409). */
const CONFLICT_ERROR_CODE = "CONFLICT";

/**
 * Whether an unknown rejection is an optimistic-concurrency conflict — the
 * server lost a write race and the caller should refetch and retry (or surface
 * the conflict). Structural check on the `code` property the client attaches
 * when decoding the worker's `{ error: { code, message } }` envelope.
 */
const isConflictError = (error: unknown): error is Error & { code: "CONFLICT" } =>
    error instanceof Error && (error as Error & { code?: unknown }).code === CONFLICT_ERROR_CODE;

/**
 * Whether a rejection is an RLS/policy denial (`FORBIDDEN`, HTTP 403) — the
 * caller is authenticated but not permitted to read/write the row. The most
 * common per-call error a UI must handle in an RLS-first app.
 */
const isForbiddenError = (error: unknown): error is Error & { code: "FORBIDDEN" } =>
    error instanceof Error && (error as Error & { code?: unknown }).code === "FORBIDDEN";

/** Whether a rejection is an authentication failure (`UNAUTHORIZED`, HTTP 401) — no/invalid identity. */
const isUnauthorizedError = (error: unknown): error is Error & { code: "UNAUTHORIZED" } =>
    error instanceof Error && (error as Error & { code?: unknown }).code === "UNAUTHORIZED";

/**
 * Whether a rejection is a rate-limit denial (`TOO_MANY_REQUESTS`, HTTP 429).
 * The retry hint (if the server sent one) is read with {@link getRetryAfterMs}.
 */
const isRateLimitedError = (error: unknown): error is Error & { code: "TOO_MANY_REQUESTS" } =>
    error instanceof Error && (error as Error & { code?: unknown }).code === "TOO_MANY_REQUESTS";

/**
 * Read the server's machine-readable `code` off a rejection, narrowed to the
 * known {@link LunoraErrorCode} union. Returns `undefined` for a non-`Error`, a
 * missing code, or a code string absent from the catalog (an app-minted code
 * passed to `LunoraError` reads as `undefined` here rather than being falsely
 * narrowed).
 */
const getErrorCode = (error: unknown): LunoraErrorCode | undefined => {
    if (!(error instanceof Error)) {
        return undefined;
    }

    const { code } = error as Error & { code?: unknown };

    return typeof code === "string" && KNOWN_ERROR_CODES.has(code) ? (code as LunoraErrorCode) : undefined;
};

/**
 * Read the rate-limit retry hint (`data.retryAfterMs`) off a
 * `TOO_MANY_REQUESTS` rejection without hand-casting the `unknown` `data`
 * payload. Returns the finite millisecond value the server sent, or `undefined`
 * when absent/non-numeric. Pair with {@link isRateLimitedError}.
 */
const getRetryAfterMs = (error: unknown): number | undefined => {
    const value = (error as { data?: { retryAfterMs?: unknown } } | null | undefined)?.data?.retryAfterMs;

    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export { CONFLICT_ERROR_CODE, getErrorCode, getRetryAfterMs, isConflictError, isForbiddenError, isRateLimitedError, isUnauthorizedError, TransportError };

export { type LunoraErrorCode } from "@lunora/errors";
