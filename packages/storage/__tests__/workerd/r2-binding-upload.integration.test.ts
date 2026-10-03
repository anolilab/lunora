/**
 * The binding-backed resumable upload provider over Miniflare's real R2
 * emulator: conditional puts, the multipart API and R2's own part-size rules,
 * not the in-memory fake the unit suite uses.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { R2UploadBucket } from "../../src/r2-binding-upload-storage";
import { createR2BindingUploadStorage, R2_PART_SIZE } from "../../src/r2-binding-upload-storage";
import { createUploadHandler } from "../../src/upload-handler";
import { pattern } from "../upload-pattern";

const ENDPOINT = "https://test.local/upload";

// The real binding has to satisfy the provider's structural type.
const bucket: R2UploadBucket = env.BUCKET;

const handler = () => createUploadHandler({ silent: true, storage: createR2BindingUploadStorage(bucket) });

const patch = async (location: string, offset: number, chunk: Uint8Array<ArrayBuffer>): Promise<Response> =>
    handler().fetch(
        new Request(location, {
            body: chunk,
            headers: { "Content-Type": "application/offset+octet-stream", "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset) },
            method: "PATCH",
        }),
    );

describe("createR2BindingUploadStorage (workerd + Miniflare R2)", () => {
    it("uploads in 1 MiB chunks, coalesced into 5 MiB parts, each request on a fresh provider", async () => {
        expect.hasAssertions();

        const total = R2_PART_SIZE + 1_234_567;
        const bytes = pattern(total);
        const created = await handler().fetch(
            new Request(ENDPOINT, {
                headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(total), "Upload-Metadata": "filetype dGV4dC9wbGFpbg==" },
                method: "POST",
            }),
        );

        expect(created.status).toBe(201);

        const location = new URL(created.headers.get("location") ?? "", ENDPOINT).href;
        const chunkSize = 1024 * 1024;

        for (let offset = 0; offset < total; offset += chunkSize) {
            // eslint-disable-next-line no-await-in-loop -- TUS chunks are sequential
            const response = await patch(location, offset, bytes.slice(offset, offset + chunkSize));

            expect([200, 204]).toContain(response.status);
        }

        const object = await env.BUCKET.get(location.split("/").pop() ?? "");

        expect(object).not.toBeNull();
        expect(object?.httpMetadata?.contentType).toBe("text/plain");

        const body = object === null ? new ArrayBuffer(0) : await object.arrayBuffer();
        const stored = new Uint8Array(body);

        // Compared by hand: a structural diff over megabytes is what is slow here.
        expect(stored.byteLength).toBe(total);
        expect(stored.every((byte, index) => byte === bytes[index])).toBe(true);

        const leftovers = await env.BUCKET.list({ prefix: `_lunora/uploads/${location.split("/").pop() ?? ""}/` });

        expect(leftovers.objects).toHaveLength(0);
    }, 60_000);

    it("answers an out-of-order PATCH with 409", async () => {
        expect.hasAssertions();

        const created = await handler().fetch(new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "100" }, method: "POST" }));
        const location = new URL(created.headers.get("location") ?? "", ENDPOINT).href;

        await expect(patch(location, 50, pattern(50))).resolves.toHaveProperty("status", 409);
        await expect(patch(location, 0, pattern(100))).resolves.toHaveProperty("status", 200);
    });

    it("honors a create-only conditional put on the real binding", async () => {
        expect.hasAssertions();

        const key = "conditional/create-only";
        const first = await env.BUCKET.put(key, "one", { onlyIf: { etagDoesNotMatch: "*" } });

        expect(first).not.toBeNull();
        await expect(env.BUCKET.put(key, "two", { onlyIf: { etagDoesNotMatch: "*" } })).resolves.toBeNull();
        await expect(env.BUCKET.put(key, "three", { onlyIf: { etagMatches: "not-the-etag" } })).resolves.toBeNull();
    });

    it("stores a file under 5 MiB in several requests with a single put", async () => {
        expect.hasAssertions();

        const total = 3_000_001;
        const bytes = pattern(total);
        const created = await handler().fetch(new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(total) }, method: "POST" }));
        const location = new URL(created.headers.get("location") ?? "", ENDPOINT).href;

        for (let offset = 0; offset < total; offset += 700_000) {
            // eslint-disable-next-line no-await-in-loop -- TUS chunks are sequential
            const response = await patch(location, offset, bytes.slice(offset, offset + 700_000));

            expect([200, 204]).toContain(response.status);
        }

        const object = await env.BUCKET.get(location.split("/").pop() ?? "");
        const body = object === null ? new ArrayBuffer(0) : await object.arrayBuffer();

        expect(body.byteLength).toBe(total);
    }, 60_000);
});

const chunkedHandler = () => createUploadHandler({ protocol: "chunked-rest", silent: true, storage: createR2BindingUploadStorage(bucket) });

const createChunked = async (total: number): Promise<string> => {
    const created = await chunkedHandler().fetch(
        new Request(ENDPOINT, { headers: { "content-type": "text/plain", "x-chunked-upload": "true", "x-total-size": String(total) }, method: "POST" }),
    );

    expect(created.status).toBe(201);

    return new URL(created.headers.get("location") ?? "", ENDPOINT).href;
};

const patchChunk = async (location: string, offset: number, chunk: Uint8Array<ArrayBuffer>): Promise<Response> =>
    chunkedHandler().fetch(
        new Request(location, {
            body: chunk,
            headers: { "content-length": String(chunk.byteLength), "content-type": "application/octet-stream", "x-chunk-offset": String(offset) },
            method: "PATCH",
        }),
    );

/** A chunked-REST `Location` names the id plus an extension; the object is keyed by the id. */
const objectKey = (location: string): string => (location.split("/").pop() ?? "").replace(/\.[^.]*$/, "");

describe("chunked REST over the R2 binding (workerd + Miniflare R2)", () => {
    it("uploads in-order chunks across a part boundary, each request on a fresh provider", async () => {
        expect.hasAssertions();

        const total = R2_PART_SIZE + 1_234_567;
        const bytes = pattern(total);
        const location = await createChunked(total);
        const chunkSize = 2 * 1024 * 1024;

        for (let offset = 0; offset < total; offset += chunkSize) {
            const end = Math.min(offset + chunkSize, total);
            // eslint-disable-next-line no-await-in-loop -- the provider takes chunks in order
            const response = await patchChunk(location, offset, bytes.slice(offset, end));

            expect(response.status).toBe(end === total ? 200 : 202);
            expect(response.headers.get("x-upload-offset")).toBe(String(end));
        }

        const head = await chunkedHandler().fetch(new Request(location, { method: "HEAD" }));

        expect(head.headers.get("x-upload-complete")).toBe("true");

        const object = await env.BUCKET.get(objectKey(location));
        const stored = new Uint8Array(object === null ? new ArrayBuffer(0) : await object.arrayBuffer());

        expect(object?.httpMetadata?.contentType).toBe("text/plain");
        expect(stored.byteLength).toBe(total);
        expect(stored.every((byte, index) => byte === bytes[index])).toBe(true);
    }, 60_000);

    it("refuses an out-of-order chunk with 409 and does not count it towards completion", async () => {
        expect.hasAssertions();

        const bytes = pattern(100);
        const location = await createChunked(100);

        await expect(patchChunk(location, 50, bytes.slice(50))).resolves.toHaveProperty("status", 409);

        const first = await patchChunk(location, 0, bytes.slice(0, 50));

        expect(first.status).toBe(202);
        expect(first.headers.get("x-upload-complete")).toBe("false");
        await expect(env.BUCKET.get(objectKey(location))).resolves.toBeNull();

        const second = await patchChunk(location, 50, bytes.slice(50));

        expect(second.status).toBe(200);
        expect(second.headers.get("x-upload-complete")).toBe("true");

        const object = await env.BUCKET.get(objectKey(location));
        const stored = new Uint8Array(object === null ? new ArrayBuffer(0) : await object.arrayBuffer());

        expect(stored.every((byte, index) => byte === bytes[index]) && stored.byteLength === 100).toBe(true);
    });
});
