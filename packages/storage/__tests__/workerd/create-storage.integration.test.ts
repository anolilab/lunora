/**
 * Phase 6 verification gate: `createStorage` drives Miniflare's real R2
 * emulator (not the in-memory fake from `__tests__/createStorage.test.ts`).
 *
 * The fake exercises the contract; this suite exercises the *implementation*
 * — confirming the binding shape we assume in `R2BucketLike` actually matches
 * the runtime R2 surface workerd exposes.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createStorage } from "../../src/create-storage";

const storage = (): ReturnType<typeof createStorage> => createStorage({ bucket: env.BUCKET, bucketName: "default" });

describe("createStorage (workerd + Miniflare R2 integration)", () => {
    it("upload then download round-trips bytes through R2", async () => {
        expect.assertions(6);

        const sut = storage();
        const payload = new TextEncoder().encode("hello lunora");

        const putResult = await sut.upload("greetings/hello.txt", payload.buffer, {
            contentType: "text/plain",
        });

        expect(putResult.key).toBe("greetings/hello.txt");
        // Runtime check that R2 returned an etag string (not a compile-time
        // `expectTypeOf`, which would assert nothing about the live value).
        expect(putResult.etag).toBeTypeOf("string");
        expect(putResult.etag.length).toBeGreaterThan(0);

        const got = await sut.download("greetings/hello.txt");

        expect(got).not.toBeNull();
        expect(got!.key).toBe("greetings/hello.txt");
        await expect(got!.text()).resolves.toBe("hello lunora");
    });

    it("download with a byte range streams only the requested window", async () => {
        expect.assertions(2);

        const sut = storage();

        await sut.upload("clip.txt", new TextEncoder().encode("abcdefghij").buffer, { contentType: "text/plain" });

        // R2 resolves the range server-side, so only these bytes come back.
        const ranged = await sut.download("clip.txt", { range: { length: 4, offset: 2 } });

        expect(ranged).not.toBeNull();
        await expect(ranged!.text()).resolves.toBe("cdef");
    });

    it("list returns objects matching the given prefix", async () => {
        expect.assertions(1);

        const sut = storage();

        await sut.upload("photos/a.jpg", new Uint8Array([1, 2, 3]).buffer);
        await sut.upload("photos/b.jpg", new Uint8Array([4, 5, 6]).buffer);
        await sut.upload("docs/readme.txt", new Uint8Array([7, 8, 9]).buffer);

        const listed = await sut.list("photos/");
        const keys = listed.objects.map((object) => object.key).toSorted((a, b) => a.localeCompare(b));

        expect(keys).toEqual(["photos/a.jpg", "photos/b.jpg"]);
    });

    it("delete removes the object", async () => {
        expect.assertions(2);

        const sut = storage();

        await sut.upload("ephemeral.txt", new TextEncoder().encode("bye").buffer);

        await expect(sut.download("ephemeral.txt")).resolves.not.toBeNull();

        await sut.delete("ephemeral.txt");

        await expect(sut.download("ephemeral.txt")).resolves.toBeNull();
    });

    it("download returns null for missing keys", async () => {
        expect.assertions(1);

        const sut = storage();

        const got = await sut.download("does/not/exist.bin");

        expect(got).toBeNull();
    });

    // R2 refuses any `ReadableStream` whose length it cannot read, so a `maxSize`
    // that wraps the body in a plain `TransformStream` makes every streaming
    // upload fail with "Provided readable stream must have a known length".
    // The unit suite's fake bucket accepts any stream, so only workerd sees it.
    it("uploads a ReadableStream body under maxSize", async () => {
        expect.assertions(2);

        const sut = storage();

        await sut.upload("streamed/ok.txt", new Blob([new TextEncoder().encode("streamed body")]).stream(), {
            contentType: "text/plain",
            maxSize: 1024,
        });

        const got = await sut.download("streamed/ok.txt");

        expect(got).not.toBeNull();
        await expect(got!.text()).resolves.toBe("streamed body");
    });

    it("rejects a ReadableStream body over maxSize without storing it", async () => {
        expect.assertions(2);

        const sut = storage();

        await expect(
            sut.upload("streamed/too-big.txt", new Blob([new TextEncoder().encode("far too many bytes for this cap")]).stream(), { maxSize: 8 }),
        ).rejects.toThrow(/maxSize/);

        await expect(sut.download("streamed/too-big.txt")).resolves.toBeNull();
    });

    // R2 omits `httpMetadata`/`customMetadata` from list entries unless the call
    // asks for them (`r2_list_honor_include`, on for every compat date since
    // 2022-08-04). The fake bucket returns whatever it stored, so only workerd
    // shows the empty objects a real bucket sends back.
    it("list reports httpMetadata and customMetadata for each entry", async () => {
        expect.assertions(2);

        const sut = storage();

        await sut.upload("meta/one.txt", new TextEncoder().encode("m").buffer, {
            contentType: "text/plain",
            customMetadata: { owner: "u1" },
        });

        const listed = await sut.list("meta/");
        const entry = listed.objects.find((object) => object.key === "meta/one.txt");

        expect(entry?.httpMetadata?.contentType).toBe("text/plain");
        expect(entry?.customMetadata).toStrictEqual({ owner: "u1" });
    });
});
