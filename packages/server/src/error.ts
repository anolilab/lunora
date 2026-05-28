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
