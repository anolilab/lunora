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

import { createStorage } from "../../src/create-storage.js";

const storage = (): ReturnType<typeof createStorage> => createStorage({ bucket: env.BUCKET });

describe("createStorage (workerd + Miniflare R2 integration)", () => {
    it("upload then download round-trips bytes through R2", async () => {
        expect.assertions(6);

        const sut = storage();
        const payload = new TextEncoder().encode("hello cirrus");

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
        await expect(got!.text()).resolves.toBe("hello cirrus");
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
});
