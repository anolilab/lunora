/**
 * The machine-readable error codes a client can observe on a failed
 * RPC/batch/subscription. Mirrors the server's `CODE_STATUS` keys
 * (`@lunora/server`'s `error.ts`) by hand — the client is framework-neutral and
 * must never import the server package (wrong dependency direction / would pull
 * the server into the browser bundle). Keep this list in sync when a server code
 * is added or removed (see the drift-guard note in the plan/maintenance docs).
 */
const LUNORA_ERROR_CODES = [
    "BAD_REQUEST",
    "CONFLICT",
    "COUNT_RLS_UNSUPPORTED",
    "FORBIDDEN",
    "INTERNAL_SERVER_ERROR",
    "MASK_UNSUPPORTED",
    "NOT_FOUND",
    "NOT_IMPLEMENTED",
    "RELATION_PREDICATE_UNSUPPORTED",
    "TOO_MANY_REQUESTS",
    "UNAUTHORIZED",
    "UNPROCESSABLE",
] as const;

/** A machine-readable error `code` the client may observe. Mirror of the server's `LunoraErrorCode`. */
type LunoraErrorCode = (typeof LUNORA_ERROR_CODES)[number];

const KNOWN_ERROR_CODES = new Set<string>(LUNORA_ERROR_CODES);

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
 * missing code, or an unrecognized code string (forward-compat server codes read
 * as `undefined` here rather than being falsely narrowed).
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

export { CONFLICT_ERROR_CODE, getErrorCode, getRetryAfterMs, isConflictError, isForbiddenError, isRateLimitedError, isUnauthorizedError };
export type { LunoraErrorCode };
