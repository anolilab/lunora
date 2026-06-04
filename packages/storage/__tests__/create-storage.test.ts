import { describe, expect, it, vi } from "vitest";

import { createStorage } from "../src/create-storage.js";
import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike } from "../src/types.js";

const BUCKET_RE = /bucket/;
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

    it("upload() forwards content-type + metadata", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        const result = await storage.upload("avatars/alice.png", new ArrayBuffer(4), {
            contentType: "image/png",
            customMetadata: { uploadedBy: "alice" },
        });

        expect(result).toEqual({ etag: "etag-new", key: "avatars/alice.png" });
        expect(bucket.puts[0]?.options).toMatchObject({
            customMetadata: { uploadedBy: "alice" },
            httpMetadata: { contentType: "image/png" },
        });
    });

    it("upload() rejects an oversized ArrayBuffer", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        await expect(storage.upload("big.bin", new ArrayBuffer(16), { maxSize: 8 })).rejects.toThrow(/exceeds maxSize/);
        expect(bucket.puts).toHaveLength(0);
    });

    it("upload() rejects an oversized Blob", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        await expect(storage.upload("big.txt", new Blob(["0123456789"]), { maxSize: 4 })).rejects.toThrow(/exceeds maxSize/);
        expect(bucket.puts).toHaveLength(0);
    });

    it("upload() does NOT enforce maxSize for a ReadableStream (documented bypass)", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        // A ReadableStream's byte count isn't known synchronously, so maxSize is
        // intentionally skipped. Callers streaming uploads must pre-buffer or
        // rely on R2 multipart enforcement. This test codifies that the stream
        // is NOT rejected so the documented limitation can't silently regress.
        const stream = new Blob(["streamed body well over the limit"]).stream();

        await expect(storage.upload("stream.bin", stream, { maxSize: 4 })).resolves.toMatchObject({ key: "stream.bin" });
        expect(bucket.puts).toHaveLength(1);
    });

    it("download() returns the R2 object body or null", async () => {
        expect.assertions(3);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        const present = await storage.download("hello.txt");

        expect(present?.key).toBe("hello.txt");
        await expect(present?.text()).resolves.toBe("ok");

        const missing = await storage.download("missing");

        expect(missing).toBeNull();
    });

    it("delete() forwards to the bucket", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        await storage.delete("k");

        expect(bucket.deletes).toEqual(["k"]);
    });

    it("list() returns objects + cursor", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        const result = await storage.list("uploads/", { limit: 50 });

        expect(result.objects.map((object) => object.key)).toEqual(["uploads/a", "uploads/b"]);
        expect(result.cursor).toBe("next-cursor");
    });

    it("list() forwards the R2 truncated flag", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();

        vi.spyOn(bucket, "list").mockImplementation(async () => {
            return { cursor: "c", objects: [], truncated: true };
        });

        const storage = createStorage({ bucket });
        const result = await storage.list();

        expect(result.truncated).toBe(true);
        expect(result.cursor).toBe("c");
    });

    it("getUrl() requires publicBaseUrl", () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        expect(() => storage.getUrl("x")).toThrow(PUBLIC_BASE_URL_RE);
    });

    it("getUrl() joins the base URL and key, trimming trailing slashes", () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, publicBaseUrl: "https://cdn.test/" });

        expect(storage.getUrl("uploads/x.png")).toBe("https://cdn.test/uploads/x.png");
    });

    it("getSignedUrl() requires publicBaseUrl + signingSecret", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        await expect(storage.getSignedUrl("x")).rejects.toThrow(PUBLIC_BASE_URL_RE);

        const partial = createStorage({ bucket, publicBaseUrl: "https://cdn.test" });

        await expect(partial.getSignedUrl("x")).rejects.toThrow(SIGNING_SECRET_RE);
    });

    it("getSignedUrl() returns a parseable URL with sig + exp", async () => {
        expect.assertions(4);

        const bucket = fakeBucket();
        const storage = createStorage({
            bucket,
            publicBaseUrl: "https://cdn.test",
            signingSecret: "shh",
        });

        const url = new URL(await storage.getSignedUrl("uploads/x.png", { expiresInSeconds: 60 }));

        expect(url.hostname).toBe("cdn.test");
        expect(url.pathname).toBe("/uploads/x.png");
        expect(url.searchParams.get("sig")).toMatch(/^[\w-]+$/);
        expect(Number(url.searchParams.get("exp"))).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("generateUploadUrl() mints a PUT URL pinning the content-type", async () => {
        expect.assertions(3);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, publicBaseUrl: "https://cdn.test", signingSecret: "shh" });

        const url = new URL(await storage.generateUploadUrl("uploads/x.png", { contentType: "image/png", expiresInSeconds: 60 }));

        expect(url.searchParams.get("method")).toBe("PUT");
        expect(url.searchParams.get("ct")).toBe("image/png");
        expect(url.searchParams.get("sig")).toMatch(/^[\w-]+$/);
    });

    it("store() forwards to upload() with the content-type", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        const result = await storage.store("docs/readme.txt", new ArrayBuffer(4), { contentType: "text/plain" });

        expect(result).toEqual({ etag: "etag-new", key: "docs/readme.txt" });
        expect(bucket.puts[0]?.options).toMatchObject({ httpMetadata: { contentType: "text/plain" } });
    });

    it("download()/list() surface a hex sha256 from R2 checksums", async () => {
        expect.assertions(3);

        // 0x01,0x02,0x03,0xff -> "010203ff"
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

        const storage = createStorage({ bucket });

        const object = await storage.download("uploads/x.png");

        expect(object?.sha256).toBe("010203ff");
        expect(object?.etag).toBe("etag-1");

        const listed = await storage.list();

        expect(listed.objects[0]?.sha256).toBe("010203ff");
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

        const storage = createStorage({ bucket });
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
});
