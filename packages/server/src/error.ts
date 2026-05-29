/**
 * Canonical error type for Cirrus procedures and middleware.
 *
 * The runtime's structural error mapper keys off `name === "CirrusError"` plus
 * the numeric `status`, so throwing one of these from a handler or middleware
 * yields the right RPC/HTTP status without any further wiring. `code` carries
 * the machine-readable reason for clients.
 */

const CODE_STATUS = {
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNPROCESSABLE: 422,
    /**
     * `count()` invoked against a table whose context carries an active RLS
     * policy. The operation itself is unsupported in an RLS-restricted reader
     * (kitcn's documented constraint) — the request is well-formed and the
     * caller is authorized, so this is a 422 (semantic conflict) rather than a
     * 403 (policy denial).
     */
    COUNT_RLS_UNSUPPORTED: 422,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
    NOT_IMPLEMENTED: 501,
} as const;

export type CirrusErrorCode = keyof typeof CODE_STATUS;

export class CirrusError extends Error {
    override readonly name = "CirrusError";

    readonly code: CirrusErrorCode;

    readonly status: number;

    constructor(code: CirrusErrorCode, message?: string) {
        super(message ?? code);
        this.code = code;
        this.status = CODE_STATUS[code];
    }
}
