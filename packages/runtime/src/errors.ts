interface CirrusErrorBody {
    error: {
        code: string;
        message: string;
    };
}

/**
 * Error type recognised by the runtime's error middleware. Anything thrown
 * that isn't a `CirrusError` is mapped to a generic 500 with code `INTERNAL`.
 */
class CirrusError extends Error {
    public readonly code: string;

    public readonly status: number;

    public constructor(message: string, options?: { cause?: unknown; code?: string; status?: number }) {
        super(message, { cause: options?.cause });
        this.name = "CirrusError";
        this.code = options?.code ?? "INTERNAL";
        this.status = options?.status ?? 500;
    }

    public toResponse(): Response {
        const body: CirrusErrorBody = { error: { code: this.code, message: this.message } };

        return Response.json(body, {
            headers: { "content-type": "application/json" },
            status: this.status,
        });
    }
}

/** Shape recognised by the runtime's structural error checks. */
type StructuralCirrusErrorLike = { code: string; message: string; name: string; status: number };

const hasErrorShape = (error: unknown, name: string): error is StructuralCirrusErrorLike => {
    if (!error || typeof error !== "object") {
        return false;
    }

    const candidate = error as { code?: unknown; message?: unknown; name?: unknown; status?: unknown };

    return candidate.name === name && typeof candidate.code === "string" && typeof candidate.status === "number" && typeof candidate.message === "string";
};

/**
 * Structural match for `ConflictError` from `@cirrus/do`. We deliberately
 * avoid importing the class so `@cirrus/runtime` stays free of a hard
 * dependency on the DO package — the contract is the public shape
 * (`name === "ConflictError"`, numeric `status`, string `code`).
 */
const isStructuralConflictError = (error: unknown): error is StructuralCirrusErrorLike => hasErrorShape(error, "ConflictError");

/**
 * Structural match for any error mirroring {@link CirrusError}'s shape
 * (`name === "CirrusError"`, numeric `status`, string `code`). Used by
 * `@cirrus/do`'s `CountRlsUnsupportedError` (and any future cross-package
 * error that opts in to the structural mapper) so packages downstream of the
 * runtime can throw transport-mappable errors without taking a runtime dep.
 */
const isStructuralCirrusError = (error: unknown): error is StructuralCirrusErrorLike => hasErrorShape(error, "CirrusError");

/** Convert any thrown value into a JSON error response. */
const toErrorResponse = (error: unknown): Response => {
    if (error instanceof CirrusError) {
        return error.toResponse();
    }

    if (isStructuralCirrusError(error) || isStructuralConflictError(error)) {
        const body: CirrusErrorBody = { error: { code: error.code, message: error.message } };

        return Response.json(body, {
            headers: { "content-type": "application/json" },
            status: error.status,
        });
    }

    // Do NOT echo arbitrary error.message values to clients — they may
    // contain stack traces, file paths, or internal identifiers. Log the
    // raw error server-side and return a generic message.
    // eslint-disable-next-line no-console
    console.error("[cirrus] unhandled error:", error);

    const body: CirrusErrorBody = { error: { code: "INTERNAL", message: "Internal error" } };

    return Response.json(body, {
        headers: { "content-type": "application/json" },
        status: 500,
    });
};

export { CirrusError, isStructuralCirrusError, isStructuralConflictError, toErrorResponse };
export type { CirrusErrorBody, StructuralCirrusErrorLike };
