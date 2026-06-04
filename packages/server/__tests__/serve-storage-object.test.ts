import { describe, expect, it } from "vitest";

import { serveStorageObject } from "../src/index.js";

interface FakeObjectOptions {
    contentType?: string;
    etag?: string;
    sha256Base64?: string;
}

/** A single-use object view; `body` streams `bytes` (a fresh stream per download). */
const fakeObject = (bytes: Uint8Array, size: number, options: FakeObjectOptions) => {
    return {
        body: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes);
                controller.close();
            },
        }),
        etag: options.etag ?? "etag-1",
        httpMetadata: { contentType: options.contentType ?? "application/octet-stream" },
        key: "k",
        sha256Base64: options.sha256Base64,
        // `size` is always the full object size, even for a ranged read (mirrors R2).
        size,
    };
};

/**
 * Build a ctx whose `download` mirrors R2's ranged-read contract: a plain
 * `download(key)` streams the whole object, while `download(key, { range })`
 * streams only the requested window (but still reports the full `size`). A fresh
 * stream is produced on every call so the two reads a range request makes don't
 * share a consumed body.
 */
const ctxWith = (bytes: Uint8Array | null, options: FakeObjectOptions = {}) => {
    return {
        storage: {
            download: async (_key: string, downloadOptions?: { range?: { length: number; offset: number } }) => {
                if (bytes === null) {
                    return null;
                }

                const range = downloadOptions?.range;
                const slice = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;

                return fakeObject(slice, bytes.byteLength, options);
            },
        },
    };
};

const BODY = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

describe("serveStorageObject", () => {
    it("returns 200 with full body + metadata headers when no Range is sent", async () => {
        expect.assertions(5);

        const ctx = ctxWith(BODY, { contentType: "text/plain", etag: "abc", sha256Base64: "3q2+7w==" });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/plain");
        // RFC 7232: ETag must be a quoted-string. R2's `etag` is unquoted hex, so
        // `serveStorageObject` wraps it.
        expect(response.headers.get("etag")).toBe('"abc"');
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        // RFC 9530 representation digest: base64 byte-sequence wrapped in colons.
        expect(response.headers.get("repr-digest")).toBe("sha-256=:3q2+7w==:");
    });

    it("does not double-quote an already-quoted (weak) ETag", async () => {
        expect.assertions(1);

        const ctx = ctxWith(BODY, { etag: 'W/"weak"' });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"));

        expect(response.headers.get("etag")).toBe('W/"weak"');
    });

    it("rejects a CRLF-bearing Content-Type to prevent header injection", async () => {
        expect.assertions(2);

        const ctx = ctxWith(BODY, { contentType: "text/html\r\nset-cookie: pwned=1" });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k"));

        // Falls back to the safe default rather than reflecting the injected value.
        expect(response.headers.get("content-type")).toBe("application/octet-stream");
        expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("returns 404 when the object is absent", async () => {
        expect.assertions(1);

        const response = await serveStorageObject(ctxWith(null), "missing", new Request("https://x/missing"));

        expect(response.status).toBe(404);
    });

    it("returns 206 with Content-Range/Content-Length for a byte range", async () => {
        expect.assertions(4);

        const ctx = ctxWith(BODY);
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=2-5" } }));

        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
        expect(response.headers.get("content-length")).toBe("4");

        const buffer = new Uint8Array(await response.arrayBuffer());

        expect([...buffer]).toEqual([2, 3, 4, 5]);
    });

    it("clamps an open-ended range (bytes=7-) to the object end", async () => {
        expect.assertions(2);

        const ctx = ctxWith(BODY);
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=7-" } }));

        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe("bytes 7-9/10");
    });

    it("serves a suffix range (bytes=-3) as the final bytes", async () => {
        expect.assertions(2);

        const ctx = ctxWith(BODY);
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=-3" } }));

        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe("bytes 7-9/10");
    });

    it("returns 416 with Content-Range */size for an out-of-bounds range", async () => {
        expect.assertions(4);

        const ctx = ctxWith(BODY, { contentType: "video/mp4", sha256Base64: "3q2+7w==" });
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=50-60" } }));

        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe("bytes */10");
        // The error body is plain text — it must not be mislabelled with the
        // object's Content-Type, nor carry the object's representation digest.
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(response.headers.get("repr-digest")).toBeNull();
    });

    it("ignores a multi-range request and serves the whole object (200)", async () => {
        expect.assertions(1);

        const ctx = ctxWith(BODY);
        const response = await serveStorageObject(ctx, "k", new Request("https://x/k", { headers: { range: "bytes=0-1,4-5" } }));

        expect(response.status).toBe(200);
    });
});
