import { describe, expect, test, vi } from "vitest";

import { createStorage } from "../src/create-storage.js";
import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike } from "../src/types.js";

const fakeObject = (key: string, etag: string = "etag-1"): R2ObjectLike => ({
    key,
    size: 4,
    etag,
    httpMetadata: { contentType: "text/plain" },
});

const fakeBucket = (): R2BucketLike & { deletes: string[]; puts: { body: unknown; key: string; options?: unknown }[] } => {
    const puts: { body: unknown; key: string; options?: unknown }[] = [];
    const deletes: string[] = [];

    return {
        puts,
        deletes,
        put: vi.fn<R2BucketLike["put"]>(async (key, body, options) => {
            puts.push({ key, body, options });

            return fakeObject(key, "etag-new");
        }),
        get: vi.fn<R2BucketLike["get"]>(async (key) => {
            if (key === "missing") {
                return null;
            }

            return {
                ...fakeObject(key),
                body: null,
                arrayBuffer: async () => new ArrayBuffer(0),
                text: async () => "ok",
            } satisfies R2ObjectBodyLike;
        }),
        delete: vi.fn<R2BucketLike["delete"]>(async (key) => {
            deletes.push(key);
        }),
        list: vi.fn<R2BucketLike["list"]>(async (options) => ({
            objects: [fakeObject(`${options?.prefix ?? ""}a`), fakeObject(`${options?.prefix ?? ""}b`)],
            cursor: options?.cursor ? undefined : "next-cursor",
        })),
    };
};

describe("createStorage", () => {
    test("throws when bucket is missing", () => {
        expect.assertions(1);

        // @ts-expect-error - intentional misuse
        expect(() => createStorage({})).toThrow(/bucket/);
    });

    test("upload() forwards content-type + metadata", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        const result = await storage.upload("avatars/alice.png", new ArrayBuffer(4), {
            contentType: "image/png",
            customMetadata: { uploadedBy: "alice" },
        });

        expect(result).toEqual({ key: "avatars/alice.png", etag: "etag-new" });
        expect(bucket.puts[0]?.options).toMatchObject({
            httpMetadata: { contentType: "image/png" },
            customMetadata: { uploadedBy: "alice" },
        });
    });

    test("download() returns the R2 object body or null", async () => {
        expect.assertions(3);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        const present = await storage.download("hello.txt");

        expect(present?.key).toBe("hello.txt");
        await expect(present?.text()).resolves.toBe("ok");

        const missing = await storage.download("missing");

        expect(missing).toBeNull();
    });

    test("delete() forwards to the bucket", async () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        await storage.delete("k");

        expect(bucket.deletes).toEqual(["k"]);
    });

    test("list() returns objects + cursor", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        const result = await storage.list("uploads/", { limit: 50 });

        expect(result.objects.map((object) => object.key)).toEqual(["uploads/a", "uploads/b"]);
        expect(result.cursor).toBe("next-cursor");
    });

    test("getUrl() requires publicBaseUrl", () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        expect(() => storage.getUrl("x")).toThrow(/publicBaseUrl/);
    });

    test("getUrl() joins the base URL and key, trimming trailing slashes", () => {
        expect.assertions(1);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket, publicBaseUrl: "https://cdn.test/" });

        expect(storage.getUrl("uploads/x.png")).toBe("https://cdn.test/uploads/x.png");
    });

    test("getSignedUrl() requires publicBaseUrl + signingSecret", async () => {
        expect.assertions(2);

        const bucket = fakeBucket();
        const storage = createStorage({ bucket });

        await expect(storage.getSignedUrl("x")).rejects.toThrow(/publicBaseUrl/);

        const partial = createStorage({ bucket, publicBaseUrl: "https://cdn.test" });

        await expect(partial.getSignedUrl("x")).rejects.toThrow(/signingSecret/);
    });

    test("getSignedUrl() returns a parseable URL with sig + exp", async () => {
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
        expect(url.searchParams.get("sig")).toBe(true);
        expect(Number(url.searchParams.get("exp"))).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
});
