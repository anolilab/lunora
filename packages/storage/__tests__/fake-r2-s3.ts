/**
 * An in-memory, path-style R2 S3 API (`https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`)
 * for the `createR2UploadStorage` tests: the object and multipart calls
 * `@visulima/storage`'s aws-light provider makes, served from a `fetch` stub.
 * Like R2, it refuses a multipart completion that breaks R2's part rules, and
 * it answers a request whose path names no bucket it holds with `404 NoSuchBucket`.
 */
import { concatParts, validParts } from "./r2-multipart-rules";

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
    /** `METHOD url` of every request, in order. */
    requests: string[];
}

const xml = (body: string, status = 200): Response =>
    new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { headers: { "content-type": "application/xml" }, status });

/** One XML element. */
const tag = (name: string, content: string): string => `<${name}>${content}</${name}>`;

const s3Error = (code: string, status: number): Response => xml(tag("Error", tag("Code", code)), status);

const withEtag = (etag: string): Response => new Response(undefined, { headers: { ETag: `"${etag}"` }, status: 200 });

/** The headers an object keeps: its type and its `x-amz-meta-*` metadata. */
const metaHeaders = (request: Request): Record<string, string> => {
    const headers: Record<string, string> = {};

    for (const [name, value] of request.headers) {
        if (name.startsWith("x-amz-meta-") || name === "content-type") {
            headers[name] = value;
        }
    }

    return headers;
};

const createFakeR2S3 = (bucket: string): FakeR2S3 => {
    const objects = new Map<string, StoredObject>();
    const uploads = new Map<string, MultipartUpload>();
    const requests: string[] = [];
    let etags = 0;
    let uploadIds = 0;

    const nextEtag = (): string => {
        etags += 1;

        return `etag-${String(etags)}`;
    };

    const sortedParts = (upload: MultipartUpload): [number, StoredObject][] => [...upload.parts.entries()].toSorted(([a], [b]) => a - b);

    /** Create, part upload, ListParts, complete and abort of one multipart upload. */
    const serveMultipart = async (request: Request, url: URL, key: string): Promise<Response> => {
        if (url.searchParams.has("uploads")) {
            uploadIds += 1;

            const id = `upload-${String(uploadIds)}`;

            uploads.set(id, { headers: metaHeaders(request), key, parts: new Map() });

            return xml(tag("InitiateMultipartUploadResult", tag("Key", key) + tag("UploadId", id)));
        }

        const id = url.searchParams.get("uploadId") ?? "";
        const upload = uploads.get(id);

        if (upload === undefined) {
            return s3Error("NoSuchUpload", 404);
        }

        if (request.method === "PUT") {
            const etag = nextEtag();

            upload.parts.set(Number(url.searchParams.get("partNumber")), { body: new Uint8Array(await request.arrayBuffer()), etag, headers: {} });

            return withEtag(etag);
        }

        if (request.method === "GET") {
            const parts = sortedParts(upload).map(([number, part]) =>
                tag("Part", tag("PartNumber", String(number)) + tag("ETag", `"${part.etag}"`) + tag("Size", String(part.body.byteLength))),
            );

            return xml(tag("ListPartsResult", parts.join("")));
        }

        uploads.delete(id);

        if (request.method !== "POST") {
            return new Response(undefined, { status: 204 });
        }

        const parts = sortedParts(upload).map(([, part]) => part.body);

        if (!validParts(parts)) {
            return s3Error("EntityTooSmall", 400);
        }

        const etag = nextEtag();

        objects.set(upload.key, { body: concatParts(parts), etag, headers: upload.headers });

        return xml(tag("CompleteMultipartUploadResult", tag("Key", upload.key) + tag("ETag", `"${etag}"`)));
    };

    /** A plain object: conditional `PUT`, `DELETE`, `HEAD` and `GET`. */
    const serveObject = async (request: Request, key: string): Promise<Response> => {
        const stored = objects.get(key);

        if (request.method === "PUT") {
            const ifMatch = request.headers.get("if-match");

            if (ifMatch !== null && `"${stored?.etag ?? ""}"` !== ifMatch) {
                return s3Error("PreconditionFailed", 412);
            }

            const etag = nextEtag();

            objects.set(key, { body: new Uint8Array(await request.arrayBuffer()), etag, headers: metaHeaders(request) });

            return withEtag(etag);
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

    const serve = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const prefix = `/${bucket}/`;

        requests.push(`${request.method} ${url.href}`);

        if (!url.pathname.startsWith(prefix)) {
            return s3Error("NoSuchBucket", 404);
        }

        const key = decodeURIComponent(url.pathname.slice(prefix.length));

        if (key === "") {
            // HeadBucket, the provider's readiness probe.
            return request.method === "HEAD" ? new Response(undefined, { status: 200 }) : s3Error("NotImplemented", 501);
        }

        return url.searchParams.has("uploads") || url.searchParams.has("uploadId") ? serveMultipart(request, url, key) : serveObject(request, key);
    };

    return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => serve(input instanceof Request ? input : new Request(input, init)),
        object: (key: string): Uint8Array | undefined => objects.get(key)?.body,
        requests,
    };
};

export type { FakeR2S3 };
export { createFakeR2S3 };
