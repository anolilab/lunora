import { isLunoraError, LunoraError as BaseLunoraError } from "@lunora/errors";

interface LunoraErrorBody {
    error: {
        code: string;
        message: string;
    };
}

/**
 * Convert any thrown value into a JSON error response.
 *
 * Recognizes any error carrying the unified Lunora shape (a string `code` + a
 * numeric `status`) via {@link isLunoraError} — this includes `@lunora/server`'s
 * `LunoraError`, this runtime `LunoraError`, and the `@lunora/do` data-layer
 * errors (`ConflictError`, `NotFoundError`, `NotUniqueError`, `RlsRequiredError`,
 * …), all of which share that shape. Everything else is redacted.
 */
const toErrorResponse = (error: unknown): Response => {
    if (isLunoraError(error)) {
        const body: LunoraErrorBody = { error: { code: error.code, message: error.message } };

        return Response.json(body, {
            headers: { "content-type": "application/json" },
            status: error.status,
        });
    }

    // Do NOT echo arbitrary error.message values to clients — they may
    // contain stack traces, file paths, or internal identifiers. Log the
    // raw error server-side and return a generic message.
    // eslint-disable-next-line no-console
    console.error("[lunora] unhandled error:", error);

    const body: LunoraErrorBody = { error: { code: "INTERNAL", message: "Internal error" } };

    return Response.json(body, {
        headers: { "content-type": "application/json" },
        status: 500,
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
