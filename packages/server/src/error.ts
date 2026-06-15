/**
 * Canonical error type for Lunora procedures and middleware.
 *
 * The runtime's structural error mapper keys off `name === "LunoraError"` plus
 * the numeric `status`, so throwing one of these from a handler or middleware
 * yields the right RPC/HTTP status without any further wiring. `code` carries
 * the machine-readable reason for clients.
 */

const CODE_STATUS = {
    BAD_REQUEST: 400,
    CONFLICT: 409,

    /**
     * `count()` invoked against a table whose context carries an active RLS
     * policy. The operation itself is unsupported in an RLS-restricted reader
     * (kitcn's documented constraint) — the request is well-formed and the
     * caller is authorized, so this is a 422 (semantic conflict) rather than a
     * 403 (policy denial).
     */
    COUNT_RLS_UNSUPPORTED: 422,
    FORBIDDEN: 403,
    INTERNAL_SERVER_ERROR: 500,

    /**
     * An analytical reduction (`aggregate` / `groupBy`) was invoked over a
     * column that the procedure's `mask()` middleware redacts. A masked column
     * can't be summed, averaged, or grouped without leaking the very values the
     * mask hides (a group key *is* the raw value; an aggregate is computed from
     * it), so the operation fails closed. The request is well-formed and the
     * caller is authorized — this is a 422 (semantic conflict), mirroring
     * `COUNT_RLS_UNSUPPORTED`.
     */
    MASK_UNSUPPORTED: 422,
    NOT_FOUND: 404,
    NOT_IMPLEMENTED: 501,
    TOO_MANY_REQUESTS: 429,
    UNAUTHORIZED: 401,
    UNPROCESSABLE: 422,
} as const;

export type LunoraErrorCode = keyof typeof CODE_STATUS;

export class LunoraError extends Error {
    public override readonly name = "LunoraError";

    public readonly code: LunoraErrorCode;

    public readonly status: number;

    public constructor(code: LunoraErrorCode, message?: string) {
        super(message ?? code);
        this.code = code;
        this.status = CODE_STATUS[code];
    }
}
