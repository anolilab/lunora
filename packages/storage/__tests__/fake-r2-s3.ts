/**
 * An in-memory, path-style R2 S3 API (`https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`)
 * for the `createR2UploadStorage` tests: the object and multipart calls
 * `@visulima/storage`'s aws-light provider makes, served from a `fetch` stub.
 * Like R2, it refuses a multipart completion whose parts are not all the same
 * size (the last may be smaller) or are under 5 MiB, and it answers a request
 * whose path names no bucket it holds with `404 NoSuchBucket`.
 */

const MIN_PART_SIZE = 5 * 1024 * 1024;

interface StoredObject {
    body: Uint8Array;
    etag: string;
    headers: Record<string, string>;
}

interface MultipartUpload {
    headers: Record<string, string>;
    key: string;
    parts: Map<number, StoredObject>;
}

interface FakeR2S3 {
    /** Serve one request; install it as `globalThis.fetch`. */
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    /** The stored object under `key`, if any. */
    object: (key: string) => Uint8Array | undefined;
    /** `METHOD path?query` of every request, in order. */
    requests: string[];
}

const xml = (body: string, status = 200): Response =>
    new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { headers: { "content-type": "application/xml" }, status });

/** One XML element. */
const tag = (name: string, content: string): string => `<${name}>${content}</${name}>`;

const s3Error = (code: string, status: number): Response => xml(tag("Error", tag("Code", code)), status);

const createFakeR2S3 = (bucket: string): FakeR2S3 => {
    const objects = new Map<string, StoredObject>();
    const uploads = new Map<string, MultipartUpload>();
    const requests: string[] = [];
    let counter = 0;

    const nextEtag = (): string => {
        counter += 1;

        return `etag-${String(counter)}`;
    };

    const metaHeaders = (request: Request): Record<string, string> => {
        const headers: Record<string, string> = {};

        for (const [name, value] of request.headers) {
            if (name.startsWith("x-amz-meta-") || name === "content-type") {
                headers[name] = value;
            }
        }

        return headers;
    };

    const complete = (upload: MultipartUpload): Response => {
        const parts = [...upload.parts.entries()].toSorted(([a], [b]) => a - b).map(([, part]) => part);
        const head = parts.slice(0, -1);

        if (head.some((part) => part.body.byteLength < MIN_PART_SIZE || part.body.byteLength !== head[0]?.body.byteLength)) {
            return s3Error("EntityTooSmall", 400);
        }

        const size = parts.reduce((total, part) => total + part.body.byteLength, 0);
        const body = new Uint8Array(size);
        let offset = 0;

        for (const part of parts) {
            body.set(part.body, offset);
            offset += part.body.byteLength;
        }

        const etag = nextEtag();

        objects.set(upload.key, { body, etag, headers: upload.headers });

        return xml(tag("CompleteMultipartUploadResult", tag("Key", upload.key) + tag("ETag", `"${etag}"`)));
    };

    // eslint-disable-next-line sonarjs/cognitive-complexity -- one switch over the S3 calls the provider makes
    const serve = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const prefix = `/${bucket}/`;

        requests.push(`${request.method} ${url.pathname}${url.search}`);

        if (!url.pathname.startsWith(prefix)) {
            return s3Error("NoSuchBucket", 404);
        }

        const key = decodeURIComponent(url.pathname.slice(prefix.length));
        const uploadId = url.searchParams.get("uploadId");

        if (key === "") {
            return request.method === "HEAD" ? new Response(undefined, { status: 200 }) : s3Error("NotImplemented", 501);
        }

        if (request.method === "POST" && url.searchParams.has("uploads")) {
            const id = `upload-${String(uploads.size + 1)}`;

            uploads.set(id, { headers: metaHeaders(request), key, parts: new Map() });

            return xml(tag("InitiateMultipartUploadResult", tag("Key", key) + tag("UploadId", id)));
        }

        if (uploadId !== null) {
            const upload = uploads.get(uploadId);

            if (upload === undefined) {
                return s3Error("NoSuchUpload", 404);
            }

            if (request.method === "PUT") {
                const etag = nextEtag();

                upload.parts.set(Number(url.searchParams.get("partNumber")), { body: new Uint8Array(await request.arrayBuffer()), etag, headers: {} });

                return new Response(undefined, { headers: { ETag: `"${etag}"` }, status: 200 });
            }

            if (request.method === "GET") {
                const parts = [...upload.parts.entries()]
                    .toSorted(([a], [b]) => a - b)
                    .map(([number, part]) =>
                        tag("Part", tag("PartNumber", String(number)) + tag("ETag", `"${part.etag}"`) + tag("Size", String(part.body.byteLength))),
                    );

                return xml(tag("ListPartsResult", parts.join("")));
            }

            if (request.method === "POST") {
                uploads.delete(uploadId);

                return complete(upload);
            }

            uploads.delete(uploadId);

            return new Response(undefined, { status: 204 });
        }

        const stored = objects.get(key);

        if (request.method === "PUT") {
            const ifMatch = request.headers.get("if-match");

            if (ifMatch !== null && `"${stored?.etag ?? ""}"` !== ifMatch) {
                return s3Error("PreconditionFailed", 412);
            }

            const etag = nextEtag();

            objects.set(key, { body: new Uint8Array(await request.arrayBuffer()), etag, headers: metaHeaders(request) });

            return new Response(undefined, { headers: { ETag: `"${etag}"` }, status: 200 });
        }

        if (request.method === "DELETE") {
            objects.delete(key);

            return new Response(undefined, { status: 204 });
        }

        if (stored === undefined) {
            return s3Error("NoSuchKey", 404);
        }

        const headers = { ...stored.headers, "content-length": String(stored.body.byteLength), etag: `"${stored.etag}"` };

        return new Response(request.method === "HEAD" ? undefined : new Uint8Array(stored.body), { headers, status: 200 });
    };

    return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => serve(input instanceof Request ? input : new Request(input, init)),
        object: (key: string): Uint8Array | undefined => objects.get(key)?.body,
        requests,
    };
};

export type { FakeR2S3 };
export { createFakeR2S3 };
