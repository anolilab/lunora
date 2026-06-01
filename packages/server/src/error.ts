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
    NOT_FOUND: 404,
    NOT_IMPLEMENTED: 501,
    TOO_MANY_REQUESTS: 429,
    UNAUTHORIZED: 401,
    UNPROCESSABLE: 422,
} as const;

export type CirrusErrorCode = keyof typeof CODE_STATUS;

export class CirrusError extends Error {
    public override readonly name = "CirrusError";

    public readonly code: CirrusErrorCode;

    public readonly status: number;

    public constructor(code: CirrusErrorCode, message?: string) {
        super(message ?? code);
        this.code = code;
        this.status = CODE_STATUS[code];
    }
}
