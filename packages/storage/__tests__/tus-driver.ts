/**
 * A raw TUS driver for `createUploadHandler({ protocol: "tus" })`, so a test
 * controls every request (no client adapter timing): create with
 * `Upload-Length`, then `PATCH` chunks at `Upload-Offset`.
 */
import type { ChunkBody } from "./chunked-rest-driver";

const TUS_ENDPOINT = "https://test.local/upload";

interface TusRoute {
    fetch: (request: Request) => Promise<Response>;
}

interface TusDriver {
    /** Start an upload of `length` bytes with the given (unencoded) metadata; answers the absolute upload URL. */
    create: (length: number, metadata?: Record<string, string>, headers?: Record<string, string>) => Promise<string>;
    delete: (location: string, headers?: Record<string, string>) => Promise<Response>;
    head: (location: string, headers?: Record<string, string>) => Promise<Response>;
    /** The offset `HEAD` reports. */
    offset: (location: string) => Promise<number>;
    /** Send one chunk. A byte body declares its `Content-Length`; pass one in `headers` for a stream. */
    patch: (location: string, offset: number, body: ChunkBody, headers?: Record<string, string>) => Promise<Response>;
}

const TUS_HEADERS = { "Tus-Resumable": "1.0.0" };

/** TUS `Upload-Metadata`: each value base64-encoded. */
const uploadMetadata = (metadata: Record<string, string>): string =>
    Object.entries(metadata)
        .map(([key, value]) => `${key} ${Buffer.from(value).toString("base64")}`)
        .join(",");

const tusDriver = (route: TusRoute, endpoint = TUS_ENDPOINT): TusDriver => {
    const head = async (location: string, headers: Record<string, string> = {}): Promise<Response> =>
        route.fetch(new Request(location, { headers: { ...TUS_HEADERS, ...headers }, method: "HEAD" }));

    return {
        create: async (length, metadata = {}, headers = {}) => {
            const response = await route.fetch(
                new Request(endpoint, {
                    headers: {
                        ...TUS_HEADERS,
                        "Upload-Length": String(length),
                        ...(Object.keys(metadata).length > 0 ? { "Upload-Metadata": uploadMetadata(metadata) } : {}),
                        ...headers,
                    },
                    method: "POST",
                }),
            );

            if (response.status !== 201) {
                throw new Error(`TUS create answered ${String(response.status)}`);
            }

            return new URL(response.headers.get("location") ?? "", endpoint).href;
        },
        delete: async (location, headers = {}) => route.fetch(new Request(location, { headers: { ...TUS_HEADERS, ...headers }, method: "DELETE" })),
        head,
        offset: async (location) => {
            const response = await head(location);

            if (response.status !== 200) {
                throw new Error(`TUS HEAD answered ${String(response.status)}`);
            }

            return Number(response.headers.get("upload-offset"));
        },
        patch: async (location, offset, body, headers = {}) =>
            route.fetch(
                new Request(location, {
                    body,
                    headers: {
                        ...TUS_HEADERS,
                        ...(body instanceof ReadableStream ? {} : { "Content-Length": String(body.byteLength) }),
                        "Content-Type": "application/offset+octet-stream",
                        "Upload-Offset": String(offset),
                        ...headers,
                    },
                    method: "PATCH",
                    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
                }),
            ),
    };
};

export type { TusDriver, TusRoute };
export { TUS_ENDPOINT, tusDriver, uploadMetadata };
