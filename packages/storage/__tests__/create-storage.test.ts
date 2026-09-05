import { describe, expect, it, vi } from "vitest";

import { createStorage } from "../src/create-storage";
import type { R2BucketLike, R2MultipartUploadLike, R2ObjectBodyLike, R2ObjectLike } from "../src/types";

const BUCKET_RE = /bucket/;
const BUCKET_NAME_RE = /bucketName/;
const PUBLIC_BASE_URL_RE = /publicBaseUrl/;
const SIGNING_SECRET_RE = /signingSecret/;

const fakeObject = (key: string, etag: string = "etag-1"): R2ObjectLike => {
    return {
        etag,
        httpMetadata: { contentType: "text/plain" },
        key,
        size: 4,
    };
};

const fakeBucket = (): R2BucketLike & { deletes: string[]; puts: { body: unknown; key: string; options?: unknown }[] } => {
    const puts: { body: unknown; key: string; options?: unknown }[] = [];
    const deletes: string[] = [];

    return {
        delete: vi.fn<R2BucketLike["delete"]>(async (key) => {
            deletes.push(key);
        }),
        deletes,
        get: vi.fn<R2BucketLike["get"]>(async (key) => {
            if (key === "missing") {
                return null;
            }

            return {
                ...fakeObject(key),
                arrayBuffer: async () => new ArrayBuffer(0),
                body: null,
                text: async () => "ok",
            } satisfies R2ObjectBodyLike;
        }),
        head: vi.fn<NonNullable<R2BucketLike["head"]>>(async (key) => {
            if (key === "missing") {
                return null;
            }

            return fakeObject(key);
        }),
        list: vi.fn<R2BucketLike["list"]>(async (options) => {
            return {
                cursor: options?.cursor ? undefined : "next-cursor",
                objects: [fakeObject(`${options?.prefix ?? ""}a`), fakeObject(`${options?.prefix ?? ""}b`)],
            };
        }),
        put: vi.fn<R2BucketLike["put"]>(async (key, body, options) => {
            puts.push({ body, key, options });

            return fakeObject(key, "etag-new");
        }),
        puts,
    };
};

describe("createStorage", () => {
    it("throws when bucket is missing", () => {
        expect.assertions(1);

        // @ts-expect-error - intentional misuse
        expect(() => createStorage({})).toThrow(BUCKET_RE);
    });

    it("exposes the bucketName it signs with, so downstream tagging agrees with the HMAC", () => {
        expect.assertions(1);

        // `asBucketStorage` reads this to tag a single-bucket `ctx.storage`, and
        // `storageRules` scopes `(bucket, operation)` rules by that tag. Without
        // it the tag fell back to "default" while `getSignedUrl` canonicalized
        // "avatars" — an `{ bucket: "avatars" }` rule then read as unreachable.
        expect(createStorage({ bucket: fakeBucket(), bucketName: "avatars" }).bucketName).toBe("avatars");
    });

    it("upload() forwards content-type + metadata", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        const result = await storage.upload("avatars/alice.png", new ArrayBuffer(4), {
            contentType: "image/png",
            customMetadata: { uploadedBy: "alice" },
        });

        expect(result).toEqual({ etag: "etag-new", httpEtag: '"etag-new"', key: "avatars/alice.png" });
        expect(bucket.puts[0]?.options).toMatchObject({
            customMetadata: { uploadedBy: "alice" },
            httpMetadata: { contentType: "image/png" },
        });
    });

    it("upload() rejects an oversized ArrayBuffer", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        await expect(storage.upload("big.bin", new ArrayBuffer(16), { maxSize: 8 })).rejects.toThrow(/exceeds maxSize/);
        expect(bucket.puts).toHaveLength(0);
    });

    it("upload() rejects an oversized Blob", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        await expect(storage.upload("big.txt", new Blob(["0123456789"]), { maxSize: 4 })).rejects.toThrow(/exceeds maxSize/);
        expect(bucket.puts).toHaveLength(0);
    });

    it("upload() enforces maxSize for a ReadableStream before anything reaches the bucket", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        // The body is read here, under the cap, rather than wrapped and handed to
        // R2 — R2 refuses any stream whose length it can't read, so a wrapper is
        // not an option. The upshot for callers is a rejection at the call, and
        // an oversized body that never reaches the bucket at all.
        const stream = new Blob(["streamed body well over the limit"]).stream();

        await expect(storage.upload("stream.bin", stream, { maxSize: 4 })).rejects.toThrow(/exceeds maxSize/);
        expect(bucket.puts).toHaveLength(0);
    });

    it("upload() refuses a non-byte-chunk ReadableStream so maxSize can't be silently defeated", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        // A ReadableStream is untyped, so a stream of string chunks reaches the
        // reader. Its length can't be measured as bytes, so counting it as 0
        // would let it flow through uncounted and defeat maxSize entirely.
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue("x".repeat(100));
                controller.close();
            },
        });

        await expect(storage.upload("s.bin", stream, { maxSize: 4 })).rejects.toThrow(/not a byte chunk|cannot enforce maxSize/);
        expect(bucket.puts).toHaveLength(0);
    });

    it("upload() hands the bucket a sized body for a streamed upload under maxSize", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        await storage.upload("ok.bin", new Blob(["under the cap"]).stream(), { maxSize: 1024 });

        // Not a `ReadableStream`: R2 rejects one whose length it cannot read.
        expect(bucket.puts[0]?.body).toBeInstanceOf(Blob);
        await expect((bucket.puts[0]?.body as Blob).text()).resolves.toBe("under the cap");
    });

    it("upload() rejects a matching-but-absent contentType when allowedContentTypes is set", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        // Omitting contentType must NOT bypass the allowlist (stored-XSS guard).
        await expect(storage.upload("doc.bin", new ArrayBuffer(4), { allowedContentTypes: ["image/png"] })).rejects.toThrow(/contentType is required/);
        expect(bucket.puts).toHaveLength(0);
    });

    it("upload() with allowedContentTypes:[] rejects every contentType (deny-all)", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        // An empty allowlist still requires a contentType to be supplied …
        await expect(storage.upload("doc.bin", new ArrayBuffer(4), { allowedContentTypes: [] })).rejects.toThrow(/contentType is required/);

        // … and rejects any value because the list includes nothing.
        await expect(storage.upload("doc.bin", new ArrayBuffer(4), { allowedContentTypes: [], contentType: "image/png" })).rejects.toThrow(
            /not in allowedContentTypes/,
        );
    });

    it("upload() with allowedContentTypes:undefined is unrestricted", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        // No allowedContentTypes at all — any contentType (or none) is accepted.
        await expect(storage.upload("doc.bin", new ArrayBuffer(4), { contentType: "application/octet-stream" })).resolves.toMatchObject({
            key: "doc.bin",
        });
    });

    it("upload() accepts an allowed contentType when allowedContentTypes is set", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        await expect(storage.upload("img.png", new ArrayBuffer(4), { allowedContentTypes: ["image/png"], contentType: "image/png" })).resolves.toMatchObject({
            key: "img.png",
        });
    });

    it.each([
        ["../escape", /path component/u],
        ["a/../b", /path component/u],
        ["/leading", /must not start with/u],
        ["nul\0byte", /NUL byte/u],
        ["", /non-empty/u],
        ["cr\rlf", /control character/u],
        ["new\nline", /control character/u],
    ])("upload() rejects an unsafe key %s before touching the bucket", async (key, pattern) => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        await expect(storage.upload(key, new ArrayBuffer(4))).rejects.toThrow(pattern);
        expect(bucket.puts).toHaveLength(0);
    });

    it("upload() rejects a key over R2's 1024-byte ceiling", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        await expect(storage.upload("a".repeat(1025), new ArrayBuffer(4))).rejects.toThrow(/1024-byte limit/u);
        expect(bucket.puts).toHaveLength(0);
    });

    it("measures the key ceiling in BYTES, not UTF-16 code units", async () => {
        expect.assertions(3);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        // 600 CJK characters: 600 code units, 1800 UTF-8 bytes. `String.length`
        // waved this through for R2 to reject remotely with an opaque error —
        // exactly the fail-fast this validation exists to provide, and exactly
        // the failure `@lunora/bindings/kv`'s twin documents and already fixed.
        // The error string here said "byte limit" while counting code units.
        await expect(storage.upload("字".repeat(600), new ArrayBuffer(4))).rejects.toThrow(/1024-byte limit/u);
        expect(bucket.puts).toHaveLength(0);

        // Well under in both measures, so it still uploads.
        await expect(storage.upload("字".repeat(100), new ArrayBuffer(4))).resolves.toBeDefined();
    });

    it("download() returns the R2 object body or null", async () => {
        expect.assertions(3);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        const present = await storage.download("hello.txt");

        expect(present?.key).toBe("hello.txt");
        await expect(present?.text()).resolves.toBe("ok");

        const missing = await storage.download("missing");

        expect(missing).toBeNull();
    });

    it("delete() forwards to the bucket", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        await storage.delete("k");

        expect(bucket.deletes).toEqual(["k"]);
    });

    it("getMetadata() returns body-free metadata from a HEAD, including custom metadata", async () => {
        expect.assertions(6);

        const bucket = fakeBucket();

        vi.spyOn(bucket, "head").mockImplementation(async (key) => {
            if (key === "missing") {
                return null;
            }

            return {
                customMetadata: { uploadedBy: "alice" },
                etag: "etag-1",
                httpMetadata: { contentType: "image/png" },
                key,
                size: 42,
                uploaded: new Date(1_700_000_000_000),
            } satisfies R2ObjectLike;
        });

        const storage = createStorage({ bucket, bucketName: "default" });

        const meta = await storage.getMetadata("avatars/alice.png");

        expect(meta).toEqual({
            contentType: "image/png",
            customMetadata: { uploadedBy: "alice" },
            key: "avatars/alice.png",
            sha256: undefined,
            size: 42,
            uploaded: 1_700_000_000_000,
        });
        expect(bucket.head).toHaveBeenCalledWith("avatars/alice.png");
        // HEAD must not pull the body — `get` is never touched on the found path.
        expect(bucket.get).not.toHaveBeenCalled();

        const missing = await storage.getMetadata("missing");

        expect(missing).toBeNull();

        // A bad key is rejected before any HEAD round-trip.
        await expect(storage.getMetadata("../escape")).rejects.toThrow(/path component/);
        await expect(storage.getMetadata("")).rejects.toThrow(/non-empty/);
    });

    it("head() returns the R2 object shape body-free, with the sha256 projection", async () => {
        expect.assertions(8);

        const checksum = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
        const bucket = fakeBucket();

        vi.spyOn(bucket, "head").mockImplementation(async (key) => {
            if (key === "missing") {
                return null;
            }

            // `Object.preventExtensions` mirrors the real R2 binding: a host object
            // a Proxy cannot advertise synthetic own keys on. A plain object literal
            // is extensible and would let a Proxy-returning `head()` pass.
            return Object.preventExtensions({ checksums: { sha256: checksum }, etag: "etag-1", httpMetadata: { contentType: "video/mp4" }, key, size: 1024 });
        });

        const storage = createStorage({ bucket, bucketName: "default" });
        const object = await storage.head("clips/a.mp4");

        // The fields a ranged HTTP response is built from: the FULL size, the
        // validator, the content-type, and the RFC 9530 digest.
        expect(object?.size).toBe(1024);
        expect(object?.etag).toBe("etag-1");
        expect(object?.httpMetadata?.contentType).toBe("video/mp4");
        expect(object?.sha256Base64).toBe("3q2+7w==");

        // A head result is routinely returned from a query, so the checksum fields
        // have to survive the wire — asserted on the SERIALIZED form rather than a
        // property read, because a Proxy answers the read and still serializes
        // without them (it cannot report synthetic own keys on a non-extensible
        // target).
        const wire = JSON.stringify(object);

        expect(wire).toContain('"sha256":"deadbeef"');
        expect(wire).toContain('"sha256Base64":"3q2+7w=="');
        // No body was pulled to learn any of it.
        expect(bucket.get).not.toHaveBeenCalled();

        await expect(storage.head("missing")).resolves.toBeNull();
    });

    it("head() falls back to a 0-length ranged get on a binding with no HEAD", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();

        // `head` is optional on `R2BucketLike` — this models a binding or double
        // that only implements `get`/`put`/`list`/`delete`.
        delete bucket.head;

        vi.spyOn(bucket, "get").mockImplementation(async (key) => ({ body: null, etag: "e", key, size: 99 }) as never);

        const storage = createStorage({ bucket, bucketName: "default" });
        const object = await storage.head("k");

        expect(object?.size).toBe(99);
        expect(bucket.get).toHaveBeenCalledWith("k", { range: { length: 0 } });
    });

    it("getMetadata() derives a hex sha256 from R2 checksums", async () => {
        expect.assertions(1);

        const checksum = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
        const bucket = fakeBucket();

        vi.spyOn(bucket, "head").mockImplementation(async (key) => {
            return {
                checksums: { sha256: checksum },
                etag: "e",
                key,
                size: 4,
            };
        });

        const storage = createStorage({ bucket, bucketName: "default" });

        const meta = await storage.getMetadata("uploads/x.bin");

        expect(meta?.sha256).toBe("deadbeef");
    });

    it("getMetadata() falls back to a 0-length ranged GET when the bucket has no head()", async () => {
        expect.assertions(3);

        const bucket = fakeBucket();

        // No `head` on this double — exercises the ranged-GET fallback path.
        delete bucket.head;

        vi.spyOn(bucket, "get").mockImplementation(async (key) => {
            if (key === "missing") {
                return null;
            }

            return {
                ...fakeObject(key),
                arrayBuffer: async () => new ArrayBuffer(0),
                body: null,
                size: 7,
                text: async () => "",
            } satisfies R2ObjectBodyLike;
        });

        const storage = createStorage({ bucket, bucketName: "default" });

        const meta = await storage.getMetadata("hello.txt");

        expect(meta).toMatchObject({ contentType: "text/plain", key: "hello.txt", size: 7 });
        expect(bucket.get).toHaveBeenCalledWith("hello.txt", { range: { length: 0 } });

        const missing = await storage.getMetadata("missing");

        expect(missing).toBeNull();
    });

    it("list() returns objects + cursor", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        const result = await storage.list("uploads/", { limit: 50 });

        expect(result.objects.map((object) => object.key)).toEqual(["uploads/a", "uploads/b"]);
        expect(result.cursor).toBe("next-cursor");
    });

    it("list() rejects a prefix containing a NUL byte", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        // R2's binding silently truncates at a NUL on some runtimes, so a NUL
        // prefix could widen the listing beyond what the caller intended.
        await expect(storage.list("uploads\0/")).rejects.toThrow(/NUL byte/u);
        expect(bucket.list).not.toHaveBeenCalled();
    });

    it("list() clamps the page limit into the [1, 1000] window", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        await storage.list("p/", { limit: 9999 });

        expect(bucket.list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1000 }));

        await storage.list("p/", { limit: 0 });

        expect(bucket.list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }));
    });

    it("list() forwards the R2 truncated flag", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();

        vi.spyOn(bucket, "list").mockImplementation(async () => {
            return { cursor: "c", objects: [], truncated: true };
        });

        const storage = createStorage({ bucket, bucketName: "default" });
        const result = await storage.list();

        expect(result.truncated).toBe(true);
        expect(result.cursor).toBe("c");
    });

    it("list() forwards R2's delimitedPrefixes (the grouped folders)", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        // With a delimiter R2 rolls the matching keys into `delimitedPrefixes`
        // and leaves `objects` empty — dropping the field made a folder browser
        // render `photos/` as an empty directory with nothing under it.
        const page = { delimitedPrefixes: ["photos/2026/"], objects: [], truncated: false };

        vi.spyOn(bucket, "list").mockImplementation(async () => page);

        const storage = createStorage({ bucket, bucketName: "default" });
        const result = await storage.list("photos/", { delimiter: "/" });

        expect(result.delimitedPrefixes).toStrictEqual(["photos/2026/"]);
        expect(result.objects).toStrictEqual([]);
    });

    it("getUrl() requires publicBaseUrl", () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        expect(() => storage.getUrl("x")).toThrow(PUBLIC_BASE_URL_RE);
    });

    it("getUrl() joins the base URL and key, trimming trailing slashes", () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default", publicBaseUrl: "https://cdn.test/" });

        expect(storage.getUrl("uploads/x.png")).toBe("https://cdn.test/uploads/x.png");
    });

    it("getSignedUrl() requires publicBaseUrl + signingSecret", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        await expect(storage.getSignedUrl("x")).rejects.toThrow(PUBLIC_BASE_URL_RE);

        const partial = createStorage({ bucket, bucketName: "default", publicBaseUrl: "https://cdn.test" });

        await expect(partial.getSignedUrl("x")).rejects.toThrow(SIGNING_SECRET_RE);
    });

    it("getSignedUrl() returns a parseable URL with sig + exp", async () => {
        expect.assertions(4);

        const bucket = fakeBucket();
        const storage = createStorage({
            bucket,
            bucketName: "default",
            publicBaseUrl: "https://cdn.test",
            signingSecret: "shh",
        });

        const url = new URL(await storage.getSignedUrl("uploads/x.png", { expiresInSeconds: 60 }));

        expect(url.hostname).toBe("cdn.test");
        expect(url.pathname).toBe("/uploads/x.png");
        expect(url.searchParams.get("sig")).toMatch(/^[\w-]+$/);
        expect(Number(url.searchParams.get("exp"))).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("getSignedUrl() binds the configured bucketName into the URL", async () => {
        expect.assertions(2);

        const storage = createStorage({ bucket: fakeBucket(), bucketName: "avatars", publicBaseUrl: "https://cdn.test", signingSecret: "shh" });
        const asDefault = createStorage({ bucket: fakeBucket(), bucketName: "default", publicBaseUrl: "https://cdn.test", signingSecret: "shh" });

        const url = new URL(await storage.getSignedUrl("uploads/x.png", { expiresInSeconds: 60 }));

        expect(url.searchParams.get("bucket")).toBe("avatars");
        expect(new URL(await asDefault.getSignedUrl("uploads/x.png", { expiresInSeconds: 60 })).searchParams.get("bucket")).toBe("default");
    });

    // Regression: `bucketName` used to be optional and fall back to `"default"`,
    // so a hand-written `createStorage({ bucket: env.AVATARS })` signed under the
    // default bucket's tag and its URLs verified against the default bucket.
    // Required at the type level (this call needs `as never` to compile at all)
    // and rejected at construction, not silently defaulted.
    it('rejects a bucketName-less construction instead of signing as "default"', () => {
        expect.assertions(2);

        // @ts-expect-error - `bucketName` is required; omitting it must not compile
        expect(() => createStorage({ bucket: fakeBucket(), publicBaseUrl: "https://cdn.test", signingSecret: "shh" })).toThrow(BUCKET_NAME_RE);

        // An empty name is the same defect wearing a string.
        expect(() => createStorage({ bucket: fakeBucket(), bucketName: "", publicBaseUrl: "https://cdn.test", signingSecret: "shh" })).toThrow(BUCKET_NAME_RE);
    });

    it("getSignedUrl() rejects a publicBaseUrl carrying a path", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default", publicBaseUrl: "https://cdn.test/files", signingSecret: "shh" });

        await expect(storage.getSignedUrl("x.png")).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    });

    it("generateUploadUrl() mints a PUT URL pinning the content-type", async () => {
        expect.assertions(3);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default", publicBaseUrl: "https://cdn.test", signingSecret: "shh" });

        const url = new URL(await storage.generateUploadUrl("uploads/x.png", { contentType: "image/png", expiresInSeconds: 60 }));

        expect(url.searchParams.get("method")).toBe("PUT");
        expect(url.searchParams.get("ct")).toBe("image/png");
        expect(url.searchParams.get("sig")).toMatch(/^[\w-]+$/);
    });

    it("store() forwards to upload() with the content-type", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        const result = await storage.store("docs/readme.txt", new ArrayBuffer(4), { contentType: "text/plain" });

        expect(result).toEqual({ etag: "etag-new", httpEtag: '"etag-new"', key: "docs/readme.txt" });
        expect(bucket.puts[0]?.options).toMatchObject({ httpMetadata: { contentType: "text/plain" } });
    });

    it("store() honors the full UploadOptions guards (maxSize/allowedContentTypes)", async () => {
        expect.assertions(3);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        // The Convex-style `store` alias must not silently drop upload()'s guards.
        await expect(storage.store("big.bin", new ArrayBuffer(16), { maxSize: 8 })).rejects.toThrow(/exceeds maxSize/);
        await expect(storage.store("note.txt", new ArrayBuffer(4), { allowedContentTypes: ["image/png"], contentType: "text/plain" })).rejects.toThrow(
            /not in allowedContentTypes/,
        );
        expect(bucket.puts).toHaveLength(0);
    });

    it("download() forwards a byte range to the bucket (ranged read)", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        await storage.download("clip.mp4", { range: { length: 4, offset: 2 } });

        expect(bucket.get).toHaveBeenCalledWith("clip.mp4", { range: { length: 4, offset: 2 } });

        // A plain download forwards no range (single-arg `get`) so R2 streams the
        // whole object — and the call avoids R2's `onlyIf` overload.
        await storage.download("clip.mp4");

        expect(bucket.get).toHaveBeenLastCalledWith("clip.mp4");
    });

    it("download()/list() surface a hex + base64 sha256 from R2 checksums", async () => {
        expect.assertions(5);

        // 0x01,0x02,0x03,0xff -> hex "010203ff", base64 "AQID/w=="
        const checksum = new Uint8Array([1, 2, 3, 255]).buffer;
        const bucket = fakeBucket();

        vi.spyOn(bucket, "get").mockImplementation(
            async (key) =>
                ({
                    arrayBuffer: async () => new ArrayBuffer(0),
                    body: null,
                    checksums: { sha256: checksum },
                    etag: "etag-1",
                    httpMetadata: { contentType: "text/plain" },
                    key,
                    size: 4,
                    text: async () => "ok",
                }) satisfies R2ObjectBodyLike,
        );
        vi.spyOn(bucket, "list").mockImplementation(async () => {
            return { objects: [{ checksums: { sha256: checksum }, etag: "e", key: "a", size: 4 }] };
        });

        const storage = createStorage({ bucket, bucketName: "default" });

        const object = await storage.download("uploads/x.png");

        expect(object?.sha256).toBe("010203ff");
        expect(object?.sha256Base64).toBe("AQID/w==");
        expect(object?.etag).toBe("etag-1");

        const listed = await storage.list();

        expect(listed.objects[0]?.sha256).toBe("010203ff");
        expect(listed.objects[0]?.sha256Base64).toBe("AQID/w==");
    });

    it("download() preserves native methods/getters of a frozen (non-extensible) R2 object", async () => {
        // Regression: a real R2Object is a non-extensible workerd host object whose
        // `body`/`arrayBuffer()`/`text()` are native and require the original object
        // as `this`. A plain `object.sha256 = …` would throw "not extensible"; an
        // `{ ...object }`/`Object.create` wrapper would break the native bindings.
        // The Proxy must add `sha256` without mutating or breaking the host object.
        expect.assertions(6);

        const checksum = new Uint8Array([0, 171, 255]).buffer; // -> "00abff"
        const bodyStream = new ReadableStream();

        // Emulate a host object: native accessors/methods that throw "Illegal
        // invocation" unless `this` is the original instance, and a frozen shell.
        const host = Object.freeze(
            Object.create(
                Object.defineProperties(
                    {},
                    {
                        arrayBuffer: {
                            value(this: unknown) {
                                if (this !== host) {
                                    throw new TypeError("Illegal invocation");
                                }

                                return Promise.resolve(new ArrayBuffer(3));
                            },
                        },
                        body: {
                            get(this: unknown) {
                                if (this !== host) {
                                    throw new TypeError("Illegal invocation");
                                }

                                return bodyStream;
                            },
                        },
                        text: {
                            value(this: unknown) {
                                if (this !== host) {
                                    throw new TypeError("Illegal invocation");
                                }

                                return Promise.resolve("ok");
                            },
                        },
                    },
                ),
                {
                    checksums: { value: { sha256: checksum } },
                    etag: { enumerable: true, value: "etag-host" },
                    httpMetadata: { enumerable: true, value: { contentType: "text/plain" } },
                    key: { enumerable: true, value: "uploads/frozen.bin" },
                    size: { enumerable: true, value: 3 },
                },
            ) as unknown as R2ObjectBodyLike,
        ) as R2ObjectBodyLike;

        const bucket = fakeBucket();

        vi.spyOn(bucket, "get").mockImplementation(async () => host);

        const storage = createStorage({ bucket, bucketName: "default" });
        const object = await storage.download("uploads/frozen.bin");

        expect(object?.sha256).toBe("00abff");
        expect(object?.etag).toBe("etag-host");
        // Native getter + methods still resolve against the original host object.
        expect(object?.body).toBe(bodyStream);
        await expect(object?.text()).resolves.toBe("ok");
        await expect(object?.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
        // The original host object was never mutated (no `sha256` own property).
        expect(Object.hasOwn(host, "sha256")).toBe(false);
    });

    it("list() sha256/sha256Base64 survive JSON serialization + spread (wire path)", async () => {
        expect.assertions(4);

        // 0x01,0x02,0x03,0xff -> hex "010203ff", base64 "AQID/w=="
        const checksum = new Uint8Array([1, 2, 3, 255]).buffer;
        const bucket = fakeBucket();

        vi.spyOn(bucket, "list").mockImplementation(async () => {
            return { objects: [{ checksums: { sha256: checksum }, etag: "e", key: "a", size: 4 }] };
        });

        const storage = createStorage({ bucket, bucketName: "default" });
        const listed = await storage.list();
        const first = listed.objects[0];

        // Regression: a Proxy over R2's non-extensible host object cannot report
        // `sha256`/`sha256Base64` via `ownKeys`, so JSON.stringify/spread/keys
        // dropped them — yet list() results are routinely returned from a query
        // and serialized to the client. The plain projection must round-trip.
        const roundTripped = structuredClone(first) as unknown as Record<string, unknown>;

        expect(roundTripped.sha256).toBe("010203ff");
        expect(roundTripped.sha256Base64).toBe("AQID/w==");
        expect(Object.keys(first ?? {})).toEqual(expect.arrayContaining(["sha256", "sha256Base64"]));
        expect({ ...first }.sha256).toBe("010203ff");
    });

    it("classifies caller input as 4xx and reserves 500 for config invariants", async () => {
        expect.assertions(5);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, bucketName: "default" });

        // A path-traversal key is a client error → VALIDATION_ERROR / 400, not a
        // redacted INTERNAL / 500 (which would strip the helpful message and
        // pollute alerting/retry logic).
        await expect(storage.upload("../escape", new ArrayBuffer(4))).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });

        // An oversized body → 413 PAYLOAD_TOO_LARGE.
        await expect(storage.upload("big.bin", new ArrayBuffer(16), { maxSize: 8 })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });

        // A disallowed content-type → 400.
        await expect(storage.upload("doc.bin", new ArrayBuffer(4), { allowedContentTypes: ["image/png"], contentType: "text/html" })).rejects.toMatchObject({
            status: 400,
        });

        // A NUL-byte list prefix → 400.
        await expect(storage.list("bad\0prefix")).rejects.toMatchObject({ status: 400 });

        // A genuine server misconfiguration stays INTERNAL / 500 (redacted).
        let thrown: unknown;

        try {
            storage.getUrl("x");
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toMatchObject({ code: "INTERNAL", status: 500 });
    });

    describe("getPresignedUrl", () => {
        it("throws when no s3 credentials are configured", async () => {
            expect.assertions(1);

            const storage = createStorage({ bucket: fakeBucket(), bucketName: "default" });

            await expect(storage.getPresignedUrl("a/b.png")).rejects.toThrow(/s3.*credentials/u);
        });

        it("mints a native S3 presigned URL when s3 credentials are configured", async () => {
            expect.assertions(3);

            const storage = createStorage({
                bucket: fakeBucket(),
                bucketName: "default",
                s3: { accessKeyId: "AKIA", accountId: "acc", bucket: "uploads", secretAccessKey: "secret" },
            });

            const url = await storage.getPresignedUrl("a/b.png", { expiresInSeconds: 600, method: "PUT" });

            expect(url.startsWith("https://acc.r2.cloudflarestorage.com/uploads/a/b.png?")).toBe(true);
            expect(url).toContain("X-Amz-Expires=600");
            expect(url).toContain("X-Amz-Signature=");
        });

        it("rejects a traversal key before signing", async () => {
            expect.assertions(1);

            const storage = createStorage({
                bucket: fakeBucket(),
                bucketName: "default",
                s3: { accessKeyId: "AKIA", accountId: "acc", bucket: "uploads", secretAccessKey: "secret" },
            });

            await expect(storage.getPresignedUrl("../etc/passwd")).rejects.toThrow(/\.\.|path component/u);
        });
    });

    describe("multipart upload", () => {
        const multipartBucket = (): R2BucketLike => {
            const base = fakeBucket();
            const makeUpload = (key: string, uploadId: string): R2MultipartUploadLike => {
                return {
                    abort: vi.fn<R2MultipartUploadLike["abort"]>(async () => undefined),
                    complete: vi.fn<R2MultipartUploadLike["complete"]>(async () => fakeObject(key, "etag-complete")),
                    key,
                    uploadId,
                    uploadPart: vi.fn<R2MultipartUploadLike["uploadPart"]>(async (partNumber) => {
                        return { etag: `etag-${String(partNumber)}`, partNumber };
                    }),
                };
            };

            return {
                ...base,
                createMultipartUpload: vi.fn<NonNullable<R2BucketLike["createMultipartUpload"]>>(async (key) => makeUpload(key, "upload-1")),
                resumeMultipartUpload: vi.fn<NonNullable<R2BucketLike["resumeMultipartUpload"]>>((key, uploadId) => makeUpload(key, uploadId)),
            };
        };

        it("creates an upload, uploads parts, and completes", async () => {
            expect.assertions(4);

            const storage = createStorage({ bucket: multipartBucket(), bucketName: "default" });
            const upload = await storage.createMultipartUpload("big/object.bin", { contentType: "application/octet-stream" });

            expect(upload.uploadId).toBe("upload-1");

            const partOne = await upload.uploadPart(1, new ArrayBuffer(8));
            const partTwo = await upload.uploadPart(2, new ArrayBuffer(8));

            expect(partOne.partNumber).toBe(1);
            expect(partTwo.etag).toBe("etag-2");

            const object = await upload.complete([partOne, partTwo]);

            expect(object.etag).toBe("etag-complete");
        });

        it("resumes an upload by id", async () => {
            expect.assertions(2);

            const storage = createStorage({ bucket: multipartBucket(), bucketName: "default" });
            const upload = storage.resumeMultipartUpload("big/object.bin", "upload-xyz");

            expect(upload.uploadId).toBe("upload-xyz");
            expect(upload.key).toBe("big/object.bin");
        });

        it("rejects an empty uploadId on resume", () => {
            expect.assertions(1);

            const storage = createStorage({ bucket: multipartBucket(), bucketName: "default" });

            expect(() => storage.resumeMultipartUpload("big/object.bin", "")).toThrow(/uploadId/u);
        });

        it("throws when the bound bucket does not support multipart", async () => {
            expect.assertions(1);

            // The default fakeBucket() has no createMultipartUpload.
            const storage = createStorage({ bucket: fakeBucket(), bucketName: "default" });

            await expect(storage.createMultipartUpload("big/object.bin")).rejects.toThrow(/multipart/u);
        });

        it("validates the key before starting an upload", async () => {
            expect.assertions(1);

            const storage = createStorage({ bucket: multipartBucket(), bucketName: "default" });

            await expect(storage.createMultipartUpload("../escape")).rejects.toThrow(/\.\.|path component/u);
        });
    });
});
