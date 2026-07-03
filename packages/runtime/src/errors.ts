import type { ErrorBody } from "@lunora/errors";
import { isLunoraError, LunoraError as BaseLunoraError, toErrorBody } from "@lunora/errors";

interface LunoraErrorBody {
    error: ErrorBody;
}

/**
 * Convert any thrown value into a JSON error response.
 *
 * Delegates the envelope + redaction to `@lunora/errors`' {@link toErrorBody} —
 * a non-internal `LunoraError` (from `@lunora/server`, this runtime, or the
 * `@lunora/do` data layer) is echoed with its `code`/`message`/`hint`/`docsUrl`;
 * an internal-coded error keeps its status but its message is redacted; anything
 * else becomes a generic `INTERNAL` 500. All of these share the unified shape
 * recognized by {@link isLunoraError}.
 */
const toErrorResponse = (error: unknown): Response => {
    const { body, redacted, status } = toErrorBody(error, { fallbackCode: "INTERNAL", redactedMessage: "Internal error" });

    if (redacted) {
        // eslint-disable-next-line no-console -- log the raw internal/unhandled error server-side; never echo it
        console.error("[lunora] internal error:", error);
    }

    return Response.json({ error: body } satisfies LunoraErrorBody, {
        headers: { "content-type": "application/json" },
        status,
    });
};

/**
 * Transport-level error for the worker entry. A thin ergonomic wrapper over the
 * shared `@lunora/errors` `LunoraError` that keeps the runtime's historical
 * `(message, { code, status })` signature — the runtime mints these with
 * dispatch-specific codes (`METHOD_NOT_ALLOWED`, `*_NOT_CONFIGURED`, …) and an
 * explicit status, so they don't need a central catalog entry. Because it is a
 * real `LunoraError`, it carries the unified wire shape and is recognized by
 * {@link isLunoraError} everywhere. Anything thrown that isn't a `LunoraError`
 * is mapped to a generic 500 with code `INTERNAL`.
 */
class LunoraError extends BaseLunoraError {
    public constructor(message: string, options?: { cause?: unknown; code?: string; status?: number }) {
        super(options?.code ?? "INTERNAL", message, { cause: options?.cause, status: options?.status });
    }

    public toResponse(): Response {
        return toErrorResponse(this);
    }
}

export { LunoraError, toErrorResponse };
export type { LunoraErrorBody };
