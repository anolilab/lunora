import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStorage } from "@lunora/storage";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeR2Bucket } from "../src/node-r2-bucket";

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("createNodeR2Bucket", () => {
    let dir: string;

    afterEach(() => {
        if (dir !== undefined) {
            rmSync(dir, { force: true, recursive: true });
        }
    });

    const freshBucket = (): ReturnType<typeof createNodeR2Bucket> => {
        dir = mkdtempSync(join(tmpdir(), "lunora-platform-node-r2-"));

        return createNodeR2Bucket({ directory: dir });
    };

    it("round-trips a string object through put/get", async () => {

        const bucket = freshBucket();
        const stored = await bucket.put("notes/hello.txt", "hello world", { httpMetadata: { contentType: "text/plain" } });

        expect(stored.key).toBe("notes/hello.txt");
        expect(stored.size).toBe(11);
        expect(stored.etag).toBe(sha256Hex("hello world"));

        const object = await bucket.get("notes/hello.txt");

        expect(object).not.toBeNull();
        await expect(object?.text()).resolves.toBe("hello world");
    });

    it("serves the body as a ReadableStream", async () => {

        const bucket = freshBucket();

        await bucket.put("a", "stream me");
        const object = await bucket.get("a");
        const text = await new Response(object?.body ?? null).text();

        expect(text).toBe("stream me");
        await expect(object?.arrayBuffer()).resolves.toEqual(new TextEncoder().encode("stream me").buffer);
    });

    it("accepts Blob, ArrayBuffer and ReadableStream bodies", async () => {

        const bucket = freshBucket();

        await bucket.put("blob", new Blob(["from-blob"]));
        await bucket.put("buf", new TextEncoder().encode("from-buffer").buffer);
        await bucket.put("stream", new Blob(["from-stream"]).stream());

        await expect((await bucket.get("blob"))?.text()).resolves.toBe("from-blob");
        await expect((await bucket.get("buf"))?.text()).resolves.toBe("from-buffer");
        await expect((await bucket.get("stream"))?.text()).resolves.toBe("from-stream");
    });

    it("head returns metadata without the body", async () => {

        const bucket = freshBucket();

        await bucket.put("meta", "x", { customMetadata: { tenant: "42" }, httpMetadata: { contentType: "application/json" } });

        const head = await bucket.head!("meta");

        expect(head).not.toBeNull();
        expect(head?.httpMetadata?.contentType).toBe("application/json");
        expect(head?.customMetadata).toStrictEqual({ tenant: "42" });
        expect(head?.sha256).toBe(sha256Hex("x"));
        expect(head?.sha256Base64).toBe(Buffer.from(sha256Hex("x"), "hex").toString("base64"));
    });

    it("supports offset/length and suffix ranges on get", async () => {

        const bucket = freshBucket();

        await bucket.put("range", "0123456789");

        await expect((await bucket.get("range", { range: { length: 3, offset: 2 } }))?.text()).resolves.toBe("234");
        await expect((await bucket.get("range", { range: { length: 4 } }))?.text()).resolves.toBe("0123");
        await expect((await bucket.get("range", { range: { offset: 7 } }))?.text()).resolves.toBe("789");
        await expect((await bucket.get("range", { range: { suffix: 3 } }))?.text()).resolves.toBe("789");
    });

    it("returns null for a missing object on get and head", async () => {

        const bucket = freshBucket();

        await expect(bucket.get("missing")).resolves.toBeNull();
        await expect(bucket.head!("missing")).resolves.toBeNull();
    });

    it("delete removes the object", async () => {

        const bucket = freshBucket();

        await bucket.put("gone", "bye");
        await bucket.delete("gone");

        await expect(bucket.get("gone")).resolves.toBeNull();
        await expect(bucket.head!("gone")).resolves.toBeNull();
        // Deleting a missing object is a no-op, not an error.
        await expect(bucket.delete("gone")).resolves.toBeUndefined();
    });

    it("lists objects with prefix, delimiter, limit and an opaque cursor", async () => {

        const bucket = freshBucket();

        await bucket.put("a/1", "1");
        await bucket.put("a/2", "2");
        await bucket.put("b/1", "3");
        await bucket.put("c", "4");

        const prefixPage = await bucket.list({ limit: 2, prefix: "a/" });

        expect(prefixPage.objects.map((object) => object.key)).toStrictEqual(["a/1", "a/2"]);
        expect(prefixPage.truncated).toBe(false);

        const two = await bucket.list({ limit: 2 });

        expect(two.objects.map((object) => object.key)).toStrictEqual(["a/1", "a/2"]);
        expect(two.truncated).toBe(true);
        expect(two.cursor).toBe("a/2");

        const rest = await bucket.list({ cursor: two.cursor, limit: 2 });

        expect(rest.objects.map((object) => object.key)).toStrictEqual(["b/1", "c"]);
        expect(rest.truncated).toBe(false);

        const grouped = await bucket.list({ delimiter: "/" });

        expect(grouped.objects.map((object) => object.key)).toStrictEqual(["c"]);
    });

    it("rejects keys that would escape or collide with the bucket layout", async () => {

        const bucket = freshBucket();

        await expect(bucket.put("/absolute", "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(bucket.put("../escape", "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(bucket.put(".lunora-meta/sneaky", "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(bucket.put("a/\0b", "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("drives the @lunora/storage seam (upload/download/getMetadata/list/delete)", async () => {

        const bucket = freshBucket();
        const storage = createStorage({ bucket });

        await storage.upload("reports/q1.json", new Blob(['{"ok":true}']), { contentType: "application/json", customMetadata: { env: "test" } });

        const downloaded = await storage.download("reports/q1.json");

        await expect(downloaded?.text()).resolves.toBe('{"ok":true}');

        const metadata = await storage.getMetadata("reports/q1.json");

        expect(metadata?.contentType).toBe("application/json");
        expect(metadata?.size).toBe(11);
        expect(metadata?.customMetadata).toStrictEqual({ env: "test" });

        const listed = await storage.list("reports/");

        expect(listed.objects.map((object) => object.key)).toStrictEqual(["reports/q1.json"]);

        await storage.delete("reports/q1.json");

        await expect(storage.download("reports/q1.json")).resolves.toBeNull();
    });
});
