/**
 * The per-protocol checks an upload route makes around `@visulima/storage`'s
 * handler, and the TUS ones: `Upload-Metadata` parsed as upstream parses it,
 * `Upload-Checksum` refused where the provider verifies none, and an `OPTIONS`
 * answer that then offers no checksums.
 */
import { ERRORS } from "@visulima/storage";

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

/** A TUS `Upload-Metadata` value: standard base64. */
const BASE64_VALUE = /^[a-z\d+/]*={0,2}$/iu;

/** Metadata keys the TUS handler keeps for itself and refuses from a client. */
const RESERVED_TUS_METADATA_KEYS = new Set(["_writeClaim", "partialIds", "uploadConcat"]);

/**
 * TUS `Upload-Metadata`, parsed as `@visulima/storage`'s TUS handler parses it
 * (its `parseMetadata` is not exported), so `maxFileSizeFor` decides on the
 * metadata that is stored. A header upstream refuses is refused here too.
 */
const tusMetadata = (header: string): { error: string } | { metadata: Record<string, string> } => {
    const metadata: Record<string, string> = {};

    for (const pair of header.split(",")) {
        if (pair.trim() === "") {
            continue;
        }

        const parts = pair.trim().split(" ");
        const [key, value] = parts;

        if (key === undefined || key === "" || parts.length > 2) {
            return { error: "Invalid Upload-Metadata header: malformed key-value pair" };
        }

        if (Object.hasOwn(metadata, key)) {
            return { error: `Invalid Upload-Metadata header: duplicate key "${key}"` };
        }

        if (RESERVED_TUS_METADATA_KEYS.has(key)) {
            return { error: `Invalid Upload-Metadata header: reserved key "${key}"` };
        }

        if (value !== undefined && value !== "" && !BASE64_VALUE.test(value)) {
            return { error: `Invalid Upload-Metadata header: value of "${key}" is not base64` };
        }

        metadata[key] = value === undefined || value === "" ? "" : Buffer.from(value, "base64").toString();
    }

    return { metadata };
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
