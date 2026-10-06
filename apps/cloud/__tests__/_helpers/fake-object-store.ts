import type { MultipartBucket, MultipartUpload, UploadedPart } from "../../src/backup/multipart";

/**
 * Object-store doubles that refuse what the real stores refuse.
 *
 * A multipart fake that accepts any part is how a 4 MiB middle part or an
 * unequal split ships green and fails on the first real snapshot. So both
 * doubles hold the rules R2 enforces — every part but the last at least 5 MiB
 * and all of them the same size, ascending part numbers, matching ETags on
 * completion — and keep an object invisible until its upload completes.
 */

const MIN_PART_BYTES = 5 * 1024 * 1024;

/** A stored object: its bytes and when the store says it was written. */
interface StoredObject {
    body: Uint8Array<ArrayBuffer>;
    uploaded: Date;
}

/** What the doubles saw, for assertions about memory and cleanup. */
interface MultipartStats {
    aborted: number;
    /** Largest part handed to `uploadPart` — the upload's peak buffer. */
    largestPart: number;
    parts: number;
}

/** What the S3 double was sent — enough to assert on signing without holding bodies. */
interface SeenRequest {
    headers: Headers;
    method: string;
    url: string;
}

type StagedParts = Map<number, { body: Uint8Array; etag: string }>;

/** Validate a completed part list the way R2 does, returning the assembled object. */
const assemble = (staged: StagedParts, parts: UploadedPart[]): Uint8Array<ArrayBuffer> => {
    if (parts.length === 0) {
        throw new Error("InvalidPart: no parts");
    }

    const bodies = parts.map((part, index) => {
        const stored = staged.get(part.partNumber);

        if (stored?.etag !== part.etag) {
            throw new Error(`InvalidPart: part ${String(part.partNumber)}`);
        }

        if (index > 0 && part.partNumber <= (parts[index - 1]?.partNumber ?? 0)) {
            throw new Error("InvalidPartOrder");
        }

        return stored.body;
    });
    const first = bodies[0]?.byteLength ?? 0;

    for (const body of bodies.slice(0, -1)) {
        if (body.byteLength < MIN_PART_BYTES) {
            throw new Error("EntityTooSmall: a non-final part is under 5 MiB");
        }

        if (body.byteLength !== first) {
            throw new Error("InvalidPart: non-final parts differ in size");
        }
    }

    const object = new Uint8Array(bodies.reduce((sum, body) => sum + body.byteLength, 0));
    let offset = 0;

    for (const body of bodies) {
        object.set(body, offset);
        offset += body.byteLength;
    }

    return object;
};

/** Stats plus the part staging that updates them. */
const partRecorder = (): { stage: (staged: StagedParts, partNumber: number, body: Uint8Array, etag: string) => void; stats: MultipartStats } => {
    const stats: MultipartStats = { aborted: 0, largestPart: 0, parts: 0 };

    return {
        stage: (staged, partNumber, body, etag) => {
            stats.parts += 1;
            stats.largestPart = Math.max(stats.largestPart, body.byteLength);
            // A copy: a store never aliases the caller's buffer.
            staged.set(partNumber, { body: Uint8Array.from(body), etag });
        },
        stats,
    };
};

const xmlEscape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const element = (tag: string, inner: string): string => `<${tag}>${inner}</${tag}>`;

const s3Error = (status: number, code: string): Response => new Response(element("Error", element("Code", code)), { status });

/** ListObjectsV2 over `objects`, paged at `pageSize` with the offset as the continuation token. */
const listObjects = (objects: Map<string, StoredObject>, url: URL, pageSize: number): Response => {
    const prefix = url.searchParams.get("prefix") ?? "";
    const start = Number(url.searchParams.get("continuation-token") ?? "0");
    const matching = [...objects.keys()].filter((name) => name.startsWith(prefix)).toSorted((a, b) => a.localeCompare(b));
    const page = matching.slice(start, start + pageSize);
    const truncated = start + page.length < matching.length;
    const contents = page.map((name) =>
        element("Contents", element("Key", xmlEscape(name)) + element("LastModified", objects.get(name)?.uploaded.toISOString() ?? "")),
    );
    const next = truncated ? element("NextContinuationToken", String(start + page.length)) : "";

    return new Response(element("ListBucketResult", element("IsTruncated", String(truncated)) + contents.join("") + next));
};

/** R2's `createMultipartUpload` over `objects`, under the binding's rules. */
export const fakeMultipart = (objects: Map<string, StoredObject>, now: () => Date = () => new Date()): MultipartBucket & { stats: MultipartStats } => {
    const { stage, stats } = partRecorder();

    return {
        createMultipartUpload: async (key): Promise<MultipartUpload> => {
            const staged: StagedParts = new Map();

            return {
                abort: async () => {
                    stats.aborted += 1;
                    staged.clear();
                },
                complete: async (parts) => {
                    objects.set(key, { body: assemble(staged, parts), uploaded: now() });
                },
                uploadPart: async (partNumber, value) => {
                    const etag = `etag-${String(partNumber)}-${String(value.byteLength)}`;

                    stage(staged, partNumber, value, etag);

                    return { etag, partNumber };
                },
            };
        },
        stats,
    };
};

/**
 * R2's S3 API for one bucket, as a `fetch`. Requires a SigV4 `authorization`
 * header naming `accessKeyId` on every request, and answers the subset of S3
 * the off-site bucket speaks: multipart create / part / complete / abort,
 * object DELETE, and ListObjectsV2 (paged at `pageSize`).
 *
 * `intercept` answers a request first when it returns a response — the way to
 * inject an outage.
 */
export const fakeS3 = (options: {
    accessKeyId: string;
    bucket: string;
    intercept?: (request: Request) => Response | undefined;
    now?: () => Date;
    objects?: Map<string, StoredObject>;
    pageSize?: number;
}): { fetch: typeof globalThis.fetch; objects: Map<string, StoredObject>; requests: SeenRequest[]; stats: MultipartStats } => {
    const objects = options.objects ?? new Map<string, StoredObject>();
    const uploads = new Map<string, StagedParts>();
    const requests: SeenRequest[] = [];
    const { stage, stats } = partRecorder();
    const now = options.now ?? (() => new Date());
    let uploadCount = 0;

    /** Part upload, completion and abort of one in-flight upload. */
    const handleUpload = async (request: Request, url: URL, key: string, uploadId: string): Promise<Response> => {
        const staged = uploads.get(uploadId);

        if (!staged) {
            return s3Error(404, "NoSuchUpload");
        }

        if (request.method === "PUT") {
            const partNumber = Number(url.searchParams.get("partNumber"));
            const body = new Uint8Array(await request.arrayBuffer());
            const etag = `"part-${String(partNumber)}-${String(body.byteLength)}"`;

            stage(staged, partNumber, body, etag);

            return new Response(null, { headers: { etag } });
        }

        if (request.method === "DELETE") {
            stats.aborted += 1;
            uploads.delete(uploadId);

            return new Response(null, { status: 204 });
        }

        const xml = await request.text();
        const parts = [...xml.matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag><\/Part>/gu)].map(([, partNumber, etag]) => {
            return { etag: etag ?? "", partNumber: Number(partNumber) };
        });

        try {
            objects.set(key, { body: assemble(staged, parts), uploaded: now() });
        } catch (error) {
            return s3Error(400, (error as Error).message.split(":")[0] ?? "InvalidPart");
        }

        uploads.delete(uploadId);

        return new Response(element("CompleteMultipartUploadResult", element("Key", xmlEscape(key))));
    };

    const handle = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const [, bucket = "", ...rest] = url.pathname.split("/");
        const key = rest.map((segment) => decodeURIComponent(segment)).join("/");
        const authorization = request.headers.get("authorization") ?? "";
        const uploadId = url.searchParams.get("uploadId");

        if (!authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/`) || !request.headers.has("x-amz-content-sha256")) {
            return s3Error(403, "AccessDenied");
        }

        if (decodeURIComponent(bucket) !== options.bucket) {
            return s3Error(404, "NoSuchBucket");
        }

        if (request.method === "POST" && url.searchParams.has("uploads")) {
            uploadCount += 1;
            uploads.set(String(uploadCount), new Map());

            return new Response(element("InitiateMultipartUploadResult", element("Key", xmlEscape(key)) + element("UploadId", String(uploadCount))));
        }

        if (uploadId !== null) {
            return handleUpload(request, url, key, uploadId);
        }

        if (request.method === "DELETE" && key !== "") {
            objects.delete(key);

            return new Response(null, { status: 204 });
        }

        if (request.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
            return listObjects(objects, url, options.pageSize ?? 1000);
        }

        return s3Error(400, "NotImplemented");
    };

    return {
        fetch: async (input: Request | string | URL, init?: RequestInit) => {
            const request = new Request(input, init);

            requests.push({ headers: request.headers, method: request.method, url: request.url });

            return options.intercept?.(request) ?? handle(request);
        },
        objects,
        requests,
        stats,
    };
};

export type { MultipartStats, SeenRequest, StoredObject };
