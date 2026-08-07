import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStorage } from "@lunora/storage";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeR2Bucket } from "../src/node-r2-bucket";

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("createNodeR2Bucket", () => {
    let dir: string;

    afterEach(() => {
        if (dir) {
            rmSync(dir, { force: true, recursive: true });
        }
    });

    const freshBucket = (): ReturnType<typeof createNodeR2Bucket> => {
        dir = mkdtempSync(join(tmpdir(), "lunora-platform-node-r2-"));

        return createNodeR2Bucket({ directory: dir });
    };

    it("round-trips a string object through put/get", async () => {
        expect.hasAssertions();

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
        expect.hasAssertions();

        const bucket = freshBucket();

        await bucket.put("a", "stream me");

        const streamed = await bucket.get("a");
        const text = await new Response(streamed?.body ?? null).text();

        expect(text).toBe("stream me");

        // A fresh get: the body is single-use, as R2's is.
        const buffered = await bucket.get("a");

        await expect(buffered?.arrayBuffer()).resolves.toEqual(new TextEncoder().encode("stream me").buffer);
    });

    it("rejects a second read of the same object body", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();

        await bucket.put("once", "only once");

        const object = await bucket.get("once");

        await expect(object?.text()).resolves.toBe("only once");
        // The handle is closed on the first read, so a second one is refused
        // rather than silently reopening the path and racing an overwrite.
        await expect(object?.arrayBuffer()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("reads body and metadata from one version when a put lands mid-read", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();

        await bucket.put("race", "A".repeat(1000));

        const object = await bucket.get("race");

        // Publishes a new version between the metadata read and the body read.
        // Reopening the path here would serve the new bytes — trailer JSON and
        // all — under the old version's size and checksum.
        await bucket.put("race", "B".repeat(10));

        const text = await object?.text();

        expect(text).toBe("A".repeat(1000));
        expect(object?.size).toBe(1000);
        expect(text).toHaveLength(object?.size ?? -1);
    });

    it("accepts Blob, ArrayBuffer and ReadableStream bodies", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();

        await bucket.put("blob", new Blob(["from-blob"]));
        await bucket.put("buf", new TextEncoder().encode("from-buffer").buffer);
        await bucket.put("stream", new Blob(["from-stream"]).stream());

        const blobResult = await bucket.get("blob");
        const bufResult = await bucket.get("buf");
        const streamResult = await bucket.get("stream");

        await expect(blobResult?.text()).resolves.toBe("from-blob");
        await expect(bufResult?.text()).resolves.toBe("from-buffer");
        await expect(streamResult?.text()).resolves.toBe("from-stream");
    });

    it("head returns metadata without the body", async () => {
        expect.hasAssertions();

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
        expect.hasAssertions();

        const bucket = freshBucket();

        await bucket.put("range", "0123456789");

        const range1 = await bucket.get("range", { range: { length: 3, offset: 2 } });
        const range2 = await bucket.get("range", { range: { length: 4 } });
        const range3 = await bucket.get("range", { range: { offset: 7 } });
        const range4 = await bucket.get("range", { range: { suffix: 3 } });

        await expect(range1?.text()).resolves.toBe("234");
        await expect(range2?.text()).resolves.toBe("0123");
        await expect(range3?.text()).resolves.toBe("789");
        await expect(range4?.text()).resolves.toBe("789");
    });

    it("returns null for a missing object on get and head", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();

        await expect(bucket.get("missing")).resolves.toBeNull();
        await expect(bucket.head!("missing")).resolves.toBeNull();
    });

    it("delete removes the object", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();

        await bucket.put("gone", "bye");
        await bucket.delete("gone");

        await expect(bucket.get("gone")).resolves.toBeNull();
        await expect(bucket.head!("gone")).resolves.toBeNull();
        // Deleting a missing object is a no-op, not an error.
        await expect(bucket.delete("gone")).resolves.toBeUndefined();
    });

    it("lists objects with prefix, delimiter, limit and an opaque cursor", async () => {
        expect.hasAssertions();

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
        expect.hasAssertions();

        const bucket = freshBucket();

        await expect(bucket.put("/absolute", "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(bucket.put("../escape", "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(bucket.put(".lunora-tmp/sneaky", "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(bucket.put("a/\0b", "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        // `\` is a path separator on Windows, so `..\outside` would escape a
        // validator that only splits on `/`.
        await expect(bucket.put(String.raw`..\outside`, "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        // `a/./b` and `a//b` would both land on the same file as `a/b`.
        await expect(bucket.put("a/./b", "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(bucket.put("a//b", "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(bucket.put("nested/../../escape", "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("resolves concurrent puts of one key to a single whole version", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();
        const bodies = Array.from({ length: 8 }, (_, index) => `version-${String(index)}`.repeat(index + 1));

        await Promise.all(bodies.map(async (body) => bucket.put("contended", body)));

        const object = await bucket.get("contended");
        const text = await object?.text();

        // Each put stages its own temp file and publishes with one rename, so the
        // winner is whole: the bytes are exactly one of the writers' payloads and
        // the metadata describes those bytes, never a blend of two.
        expect(bodies).toContain(text);
        expect(object?.size).toBe(text?.length);
        expect(object?.sha256).toBe(sha256Hex(text ?? ""));

        // Staging is drained — a put that wins or loses leaves nothing behind.
        expect(readdirSync(join(dir, ".lunora-tmp"))).toStrictEqual([]);

        const listed = await bucket.list();

        expect(listed.objects.map((entry) => entry.key)).toStrictEqual(["contended"]);
    });

    it("keeps keys that the filesystem would fold distinct", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();

        // Case folds on APFS/NTFS, trailing dot and space are stripped by
        // Windows, and `x:y` is an NTFS alternate data stream. R2 keeps all of
        // these as separate keys, so the on-disk mapping has to as well.
        await bucket.put("Report", "upper");
        await bucket.put("report", "lower");
        await bucket.put("dir/File.TXT", "mixed");

        await expect(bucket.get("Report").then(async (o) => o?.text())).resolves.toBe("upper");
        await expect(bucket.get("report").then(async (o) => o?.text())).resolves.toBe("lower");
        await expect(bucket.get("dir/File.TXT").then(async (o) => o?.text())).resolves.toBe("mixed");

        // Round-trips through list as the key the caller wrote, not the escaped
        // filename it is stored under.
        const listed = await bucket.list();

        expect(listed.objects.map((object) => object.key)).toStrictEqual(["Report", "dir/File.TXT", "report"]);

        // Deleting one leaves its case-sibling alone.
        await bucket.delete("Report");

        await expect(bucket.head!("Report")).resolves.toBeNull();
        await expect(bucket.get("report").then(async (o) => o?.text())).resolves.toBe("lower");

        // A literal `%` in a key is not confused with an escape.
        await bucket.put("100%25", "literal");

        await expect(bucket.get("100%25").then(async (o) => o?.text())).resolves.toBe("literal");
        await expect(bucket.get("100%")).resolves.toBeNull();
    });

    it("survives a file it cannot decode, and bounds the escaped segment", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();

        await bucket.put("real", "kept");
        // A stray `%` is not a valid escape; `decodeURIComponent` throws on it,
        // and a bucket directory is a directory people drop files into.
        writeFileSync(join(dir, "100%"), "hand-written");

        const listed = await bucket.list();

        expect(listed.objects.map((object) => object.key)).toStrictEqual(["real"]);

        // Escaping triples an uppercase character, so the raw 1024-byte ceiling
        // is not enough to keep the filename inside the filesystem's limit.
        await expect(bucket.put("A".repeat(200), "x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        // The same length in lowercase escapes to nothing and is fine.
        await expect(bucket.put("a".repeat(200), "x")).resolves.toMatchObject({ size: 1 });
    });

    it("leaves the previous version whole when a put fails mid-body", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();

        await bucket.put("doc", "original", { httpMetadata: { contentType: "text/plain" } });

        const failing = new ReadableStream({
            // A different length from "original", so a partially-published body
            // could not pass the size assertion by coincidence.
            pull(controller) {
                controller.enqueue(new TextEncoder().encode("a much longer replacement"));
                controller.error(new Error("upstream died"));
            },
        });

        await expect(bucket.put("doc", failing)).rejects.toThrow("upstream died");

        // Bytes and metadata are published by one rename, so a torn put cannot
        // leave the new body carrying the old checksum (or the reverse).
        const object = await bucket.get("doc");

        await expect(object?.text()).resolves.toBe("original");
        expect(object?.sha256).toBe(sha256Hex("original"));
        expect(object?.size).toBe(8);
        expect(object?.httpMetadata?.contentType).toBe("text/plain");

        // Nothing left staged.
        expect(readdirSync(join(dir, ".lunora-tmp"))).toStrictEqual([]);
    });

    it("streams a multi-chunk body through put and back out of a range read", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();
        const chunkCount = 16;
        const chunk = "lunora-chunk-pad".repeat(4096); // 64 KiB per chunk, 1 MiB total
        let pushed = 0;

        const source = new ReadableStream({
            pull(controller) {
                if (pushed === chunkCount) {
                    controller.close();

                    return;
                }

                controller.enqueue(new TextEncoder().encode(chunk));
                pushed += 1;
            },
        });

        const stored = await bucket.put("big", source);
        const whole = chunk.repeat(chunkCount);

        expect(pushed).toBe(chunkCount);
        expect(stored.size).toBe(whole.length);
        expect(stored.sha256).toBe(sha256Hex(whole));

        // A window that starts and ends inside the object, spanning a chunk
        // boundary — the read must land on body bytes only, never the trailer.
        const middle = await bucket.get("big", { range: { length: 20, offset: 65_526 } });

        await expect(middle?.text()).resolves.toBe(whole.slice(65_526, 65_546));

        // And the tail, which sits immediately before the trailer.
        const tail = await bucket.get("big", { range: { suffix: 8 } });

        await expect(tail?.text()).resolves.toBe(whole.slice(-8));

        const streamed = await bucket.get("big");
        const drained = await new Response(streamed?.body ?? null).text();

        expect(drained).toHaveLength(whole.length);
        expect(drained).toBe(whole);
    });

    it("treats a corrupt or truncated object as absent rather than throwing", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();

        await bucket.put("good", "fine");
        await bucket.put("truncated", "some content here");
        await bucket.put("badjson", "some content here");

        // Cut the trailer off entirely.
        truncateSync(join(dir, "truncated"), 4);

        // Keep the magic and length, corrupt the JSON they describe.
        const corrupt = readFileSync(join(dir, "badjson"));

        corrupt.fill(0x7b, 0, corrupt.length - 8);
        writeFileSync(join(dir, "badjson"), corrupt);

        await expect(bucket.get("truncated")).resolves.toBeNull();
        await expect(bucket.head!("truncated")).resolves.toBeNull();
        await expect(bucket.get("badjson")).resolves.toBeNull();
        await expect(bucket.head!("badjson")).resolves.toBeNull();

        // One damaged file must not take the whole listing down with it.
        const listed = await bucket.list();

        expect(listed.objects.map((object) => object.key)).toStrictEqual(["good"]);
    });

    it("advances the cursor past keys that dropped out of a page", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();

        await bucket.put("a", "1");
        await bucket.put("b", "2");
        await bucket.put("d", "4");

        // Sorts between "b" and "d", so it lands last in a limit-3 page and is
        // then filtered out of the results. A cursor taken from the returned
        // objects would rewind to "b" and re-serve it.
        writeFileSync(join(dir, "c"), "hand-written");

        const first = await bucket.list({ limit: 3 });

        expect(first.objects.map((object) => object.key)).toStrictEqual(["a", "b"]);
        expect(first.truncated).toBe(true);
        expect(first.cursor).toBe("c");

        const second = await bucket.list({ cursor: first.cursor, limit: 3 });

        expect(second.objects.map((object) => object.key)).toStrictEqual(["d"]);
        expect(second.truncated).toBe(false);
    });

    it("ignores an unrelated file dropped into the bucket directory", async () => {
        expect.hasAssertions();

        const bucket = freshBucket();

        writeFileSync(join(dir, "not-an-object.txt"), "hand-written");

        await expect(bucket.get("not-an-object.txt")).resolves.toBeNull();
        await expect(bucket.head!("not-an-object.txt")).resolves.toBeNull();

        const listed = await bucket.list();

        expect(listed.objects).toStrictEqual([]);
    });

    it("drives the @lunora/storage seam (upload/download/getMetadata/list/delete)", async () => {
        expect.hasAssertions();

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
