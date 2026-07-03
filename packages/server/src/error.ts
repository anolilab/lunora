/**
 * Canonical error type for Lunora procedures and middleware.
 *
 * This is a thin, ergonomic wrapper over the shared `@lunora/errors`
 * `LunoraError`: it keeps the historical `(code, message?, data?)` signature
 * (the third argument is the wire-encodable `data` payload) so the existing
 * throw sites are unchanged, while delegating status/title/hint resolution to the
 * central catalog. The runtime's structural error mapper keys off the shared
 * shape (`isLunoraError`: string `code` + numeric `status`), so throwing one of
 * these from a handler or middleware yields the right RPC/HTTP status without any
 * further wiring. `code` carries the machine-readable reason for clients; the
 * optional `data` carries a structured, JSON+wire-encodable payload propagated
 * verbatim to the client (e.g. `{ retryAfterMs }`). Only an explicit
 * `LunoraError`'s `data` crosses the wire — an unhandled throw is still redacted
 * to a generic message server-side.
 */
import type { LunoraErrorCode } from "@lunora/errors";
import { LunoraError as BaseLunoraError } from "@lunora/errors";

export type { LunoraErrorCode } from "@lunora/errors";

export class LunoraError extends BaseLunoraError {
    public constructor(code: LunoraErrorCode, message?: string, data?: unknown) {
        super(code, message, { data });
    }
}
