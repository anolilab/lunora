interface LunoraErrorBody {
    error: {
        code: string;
        message: string;
    };
}

/**
 * Error type recognised by the runtime's error middleware. Anything thrown
 * that isn't a `LunoraError` is mapped to a generic 500 with code `INTERNAL`.
 */
class LunoraError extends Error {
    public readonly code: string;

    public readonly status: number;

    public constructor(message: string, options?: { cause?: unknown; code?: string; status?: number }) {
        super(message, { cause: options?.cause });
        this.name = "LunoraError";
        this.code = options?.code ?? "INTERNAL";
        this.status = options?.status ?? 500;
    }

    public toResponse(): Response {
        const body: LunoraErrorBody = { error: { code: this.code, message: this.message } };

        return Response.json(body, {
            headers: { "content-type": "application/json" },
            status: this.status,
        });
    }
}

/** Shape recognised by the runtime's structural error checks. */
type StructuralLunoraErrorLike = { code: string; message: string; name: string; status: number };

const hasErrorShape = (error: unknown, name: string): error is StructuralLunoraErrorLike => {
    if (!error || typeof error !== "object") {
        return false;
    }

    const candidate = error as { code?: unknown; message?: unknown; name?: unknown; status?: unknown };

    return candidate.name === name && typeof candidate.code === "string" && typeof candidate.status === "number" && typeof candidate.message === "string";
};

/**
 * Structural match for `ConflictError` from `@lunora/do`. We deliberately
 * avoid importing the class so `@lunora/runtime` stays free of a hard
 * dependency on the DO package — the contract is the public shape
 * (`name === "ConflictError"`, numeric `status`, string `code`).
 */
const isStructuralConflictError = (error: unknown): error is StructuralLunoraErrorLike => hasErrorShape(error, "ConflictError");

/**
 * Structural match for any error mirroring {@link LunoraError}'s shape
 * (`name === "LunoraError"`, numeric `status`, string `code`). Used by
 * `@lunora/do`'s `CountRlsUnsupportedError` (and any future cross-package
 * error that opts in to the structural mapper) so packages downstream of the
 * runtime can throw transport-mappable errors without taking a runtime dep.
 */
const isStructuralLunoraError = (error: unknown): error is StructuralLunoraErrorLike => hasErrorShape(error, "LunoraError");

/** Convert any thrown value into a JSON error response. */
const toErrorResponse = (error: unknown): Response => {
    if (error instanceof LunoraError) {
        return error.toResponse();
    }

    if (isStructuralLunoraError(error) || isStructuralConflictError(error)) {
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

export { isStructuralConflictError, isStructuralLunoraError, LunoraError, toErrorResponse };
export type { LunoraErrorBody, StructuralLunoraErrorLike };
