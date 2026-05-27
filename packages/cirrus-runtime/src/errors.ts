export interface CirrusErrorBody {
    error: {
        code: string;
        message: string;
    };
}

/**
 * Error type recognised by the runtime's error middleware. Anything thrown
 * that isn't a `CirrusError` is mapped to a generic 500 with code `INTERNAL`.
 */
export class CirrusError extends Error {
    public readonly code: string;

    public readonly status: number;

    constructor(message: string, options: { code: string; status?: number; cause?: unknown } = { code: "INTERNAL" }) {
        super(message, { cause: options.cause });
        this.name = "CirrusError";
        this.code = options.code;
        this.status = options.status ?? 500;
    }

    public toResponse(): Response {
        const body: CirrusErrorBody = { error: { code: this.code, message: this.message } };

        return new Response(JSON.stringify(body), {
            status: this.status,
            headers: { "content-type": "application/json" },
        });
    }
}

/** Convert any thrown value into a JSON error response. */
export const toErrorResponse = (error: unknown): Response => {
    if (error instanceof CirrusError) {
        return error.toResponse();
    }

    // Do NOT echo arbitrary error.message values to clients — they may
    // contain stack traces, file paths, or internal identifiers. Log the
    // raw error server-side and return a generic message.
    // eslint-disable-next-line no-console
    console.error("[cirrus] unhandled error:", error);

    const body: CirrusErrorBody = { error: { code: "INTERNAL", message: "Internal error" } };

    return new Response(JSON.stringify(body), {
        status: 500,
        headers: { "content-type": "application/json" },
    });
};
