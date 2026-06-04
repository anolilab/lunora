import { describe, expect, it } from "vitest";

import { serveStorageObject } from "../src/index.js";

/** Minimal storage-object double; `body` carries the bytes, `arrayBuffer` backs range slicing. */
const fakeObject = (bytes: Uint8Array, options: { contentType?: string; etag?: string; sha256?: string } = {}) => {
    const buffer = new ArrayBuffer(bytes.byteLength);

    new Uint8Array(buffer).set(bytes);

    return {
        arrayBuffer: async () => buffer,
        body: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes);
                controller.close();
            },
        }),
        etag: options.etag ?? "etag-1",
        httpMetadata: { contentType: options.contentType ?? "application/octet-stream" },
        key: "k",
        sha256: options.sha256,
        size: bytes.byteLength,
    };
};

const ctxWith = (object: ReturnType<typeof fakeObject> | null) => {
    return { storage: { download: async () => object } };
};

const BODY = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

describe("serveStorageObject", () => {
    it("returns 200 with full body + metadata headers when no Range is sent", async () => {
        expect.assertions(5);

        const ctx = ctxWith(fakeObject(BODY, { contentType: "text/plain", etag: "abc", sha256: "deadbeef" }));
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/plain");
        expect(response.headers.get("etag")).toBe("abc");
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(response.headers.get("digest")).toBe("sha-256=deadbeef");
    });

    it("returns 404 when the object is absent", async () => {
        expect.assertions(1);

        const response = await serveStorageObject(ctxWith(null), "missing", new Request("https://x/missing"));

        expect(response.status).toBe(404);
    });

    it("returns 206 with Content-Range/Content-Length for a byte range", async () => {
        expect.assertions(4);

        const ctx = ctxWith(fakeObject(BODY));
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=2-5" } }));

        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
        expect(response.headers.get("content-length")).toBe("4");

        const buffer = new Uint8Array(await response.arrayBuffer());

        expect([...buffer]).toEqual([2, 3, 4, 5]);
    });

    it("clamps an open-ended range (bytes=7-) to the object end", async () => {
        expect.assertions(2);

        const ctx = ctxWith(fakeObject(BODY));
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=7-" } }));

        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe("bytes 7-9/10");
    });

    it("serves a suffix range (bytes=-3) as the final bytes", async () => {
        expect.assertions(2);

        const ctx = ctxWith(fakeObject(BODY));
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=-3" } }));

        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe("bytes 7-9/10");
    });

    it("returns 416 with Content-Range */size for an out-of-bounds range", async () => {
        expect.assertions(2);

        const ctx = ctxWith(fakeObject(BODY));
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=50-60" } }));

        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe("bytes */10");
    });

    it("ignores a multi-range request and serves the whole object (200)", async () => {
        expect.assertions(1);

        const ctx = ctxWith(fakeObject(BODY));
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=0-1,4-5" } }));

        expect(response.status).toBe(200);
    });
});
