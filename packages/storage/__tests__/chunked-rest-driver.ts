/**
 * A raw chunked-REST driver for `createUploadHandler({ protocol: "chunked-rest" })`,
 * shared by the unit and workerd upload suites: create with `X-Chunked-Upload`,
 * then `PATCH` chunks at `X-Chunk-Offset`.
 */

const CHUNKED_REST_ENDPOINT = "https://test.local/upload";

interface ChunkedRestRoute {
    fetch: (request: Request) => Promise<Response>;
}

/** A `PATCH` body: bytes, or a stream (which needs half-duplex in Node's fetch). */
type ChunkBody = ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>;

interface ChunkedRestDriver {
    create: (total: number, contentType?: string) => Promise<string>;
    head: (location: string) => Promise<Response>;
    patch: (location: string, offset: number, body: ChunkBody, length?: number) => Promise<Response>;
}

interface RoutedFetch {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    /** `METHOD pathname` of every request, in order. */
    requests: string[];
}

const chunkedRest = (route: ChunkedRestRoute, endpoint = CHUNKED_REST_ENDPOINT): ChunkedRestDriver => {
    return {
        /** Start an upload of `total` bytes; answers the absolute upload URL (`<collection>/<id>.<ext>`). */
        create: async (total: number, contentType = "application/octet-stream"): Promise<string> => {
            const response = await route.fetch(
                new Request(endpoint, {
                    headers: { "content-type": contentType, "x-chunked-upload": "true", "x-total-size": String(total) },
                    method: "POST",
                }),
            );

            if (response.status !== 201) {
                throw new Error(`chunked-REST create answered ${String(response.status)}`);
            }

            return new URL(response.headers.get("location") ?? "", endpoint).href;
        },
        head: async (location: string): Promise<Response> => route.fetch(new Request(location, { method: "HEAD" })),
        /** Send one chunk. A stream body declares `length` as its `Content-Length`. */
        patch: async (location: string, offset: number, body: ChunkBody, length = body instanceof ReadableStream ? 0 : body.byteLength): Promise<Response> =>
            route.fetch(
                new Request(location, {
                    body,
                    headers: { "content-length": String(length), "content-type": "application/octet-stream", "x-chunk-offset": String(offset) },
                    method: "PATCH",
                    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
                }),
            ),
    };
};

/** The upload id in a chunked-REST URL: its last segment, without the extension the handler appends. */
const uploadId = (location: string): string => (location.split("/").pop() ?? "").replace(/\.[^.]*$/u, "");

/**
 * A `fetch` that routes every request at `route`, the way a browser client
 * would reach the Worker, and logs `METHOD pathname` for each one.
 */
const routedFetch = (route: ChunkedRestRoute, origin = "https://test.local"): RoutedFetch => {
    const requests: string[] = [];

    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        requests.push(`${request.method} ${url.pathname}`);

        return route.fetch(new Request(`${origin}${url.pathname}${url.search}`, request));
    };

    return { fetch, requests };
};

export type { ChunkedRestDriver, ChunkedRestRoute, RoutedFetch };
export { CHUNKED_REST_ENDPOINT, chunkedRest, routedFetch, uploadId };
