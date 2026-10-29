/**
 * The per-protocol checks an upload route makes around `@visulima/storage`'s
 * handler, and the TUS ones: `Upload-Metadata` parsed by upstream's parser,
 * `Upload-Checksum` refused where the provider verifies none, and an `OPTIONS`
 * answer that then offers no checksums.
 */
import { ERRORS, parseTusMetadata } from "@visulima/storage";

/** What a request declares about its file, as the protocol handler reads it. */
interface DeclaredFile {
    /** The request's own type (chunked REST), or `undefined` where the metadata names it (TUS). */
    contentType: string | undefined;
    metadata: Record<string, unknown>;
}

/** A refusal before `authorize`, or what the request declares. */
type RouteCheck = { declared: DeclaredFile } | { refusal: Response };

/** The protocol-specific part of an upload route, built once per handler. */
interface RoutePolicy {
    /** Runs before `authorize`. */
    check: (request: Request) => RouteCheck;
    /** Adjusts the protocol handler's response. */
    finish: (request: Request, response: Response) => Response;
}

// TUS requires `Tus-Resumable` on every response, denials included, or a
// client reads the response as a protocol error rather than as a refusal.
const TUS_RESUMABLE = "1.0.0";

/** An error in visulima's `ApiError` shape, so `@visulima/storage-client` surfaces `status` and `code`. */
const tusErrorResponse = (status: number, error: { code: string; message: string; name: string }): Response =>
    Response.json({ error }, { headers: { "content-type": "application/json", "Tus-Resumable": TUS_RESUMABLE }, status });

/**
 * TUS `Upload-Metadata`, parsed by `@visulima/storage`'s own TUS parser, so
 * `maxFileSizeFor` decides on the metadata that is stored and a header
 * upstream refuses is refused here too.
 */
const tusMetadata = (header: string): { error: string } | { metadata: Record<string, string> } => {
    try {
        return { metadata: Object.fromEntries(Object.entries(parseTusMetadata(header))) as Record<string, string> };
    } catch (error) {
        return { error: error instanceof Error ? error.message : "Invalid Upload-Metadata header" };
    }
};

/**
 * A TUS `OPTIONS` answer that offers no checksums, for a route that refuses
 * `Upload-Checksum`. Every other extension is kept.
 */
const withoutChecksumAlgorithms = (response: Response): Response => {
    const headers = new Headers(response.headers);
    const extensions = headers.get("Tus-Extension");

    headers.delete("Tus-Checksum-Algorithm");

    if (extensions !== null) {
        headers.set(
            "Tus-Extension",
            extensions
                .split(",")
                .filter((extension) => extension.trim() !== "checksum")
                .join(","),
        );
    }

    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
};

const NO_METADATA: RouteCheck = { declared: { contentType: undefined, metadata: {} } };

/**
 * The TUS route policy. Upstream reads `Upload-Metadata` on `POST` and `PATCH`,
 * so an invalid one is refused there (`400`) before `authorize`.
 *
 * Where the provider verifies no checksum (`verifiesChecksums` false), a
 * request carrying bytes with `Upload-Checksum` is refused too: upstream would
 * buffer the chunk to verify it, about twice its size at peak, which a few
 * concurrent requests could use to exhaust an isolate.
 */
const tusRoutePolicy = (verifiesChecksums: boolean): RoutePolicy => {
    return {
        check: (request) => {
            if (request.method !== "POST" && request.method !== "PATCH") {
                return NO_METADATA;
            }

            const parsed = tusMetadata(request.headers.get("Upload-Metadata") ?? "");

            if ("error" in parsed) {
                return { refusal: tusErrorResponse(400, { code: "BadRequestError", message: parsed.error, name: "BadRequestError" }) };
            }

            if (!verifiesChecksums && request.headers.has("Upload-Checksum")) {
                return {
                    refusal: tusErrorResponse(400, {
                        code: ERRORS.UNSUPPORTED_CHECKSUM_ALGORITHM,
                        message: "Upload-Checksum is not supported on this upload route: its storage verifies no checksums",
                        name: "BadRequestError",
                    }),
                };
            }

            return { declared: { contentType: undefined, metadata: parsed.metadata } };
        },
        finish: (request, response) => (request.method === "OPTIONS" && !verifiesChecksums ? withoutChecksumAlgorithms(response) : response),
    };
};

export type { DeclaredFile, RouteCheck, RoutePolicy };
export { TUS_RESUMABLE, tusErrorResponse, tusRoutePolicy };
