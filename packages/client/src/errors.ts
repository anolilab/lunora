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

export { CONFLICT_ERROR_CODE, isConflictError };
