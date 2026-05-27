/**
 * Phase 6 verification gate: `createStorage` drives Miniflare's real R2
 * emulator (not the in-memory fake from `__tests__/createStorage.test.ts`).
 *
 * The fake exercises the contract; this suite exercises the *implementation*
 * — confirming the binding shape we assume in `R2BucketLike` actually matches
 * the runtime R2 surface workerd exposes.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { createStorage } from "../../src/createStorage.js";
import type { R2BucketLike } from "../../src/types.js";

const storage = (): ReturnType<typeof createStorage> => createStorage({ bucket: env.BUCKET as unknown as R2BucketLike });

describe("createStorage (workerd + Miniflare R2 integration)", () => {
    test("upload then download round-trips bytes through R2", async () => {
        const sut = storage();
        const payload = new TextEncoder().encode("hello cirrus");

        const putResult = await sut.upload("greetings/hello.txt", payload.buffer as ArrayBuffer, {
            contentType: "text/plain",
        });

        expect(putResult.key).toBe("greetings/hello.txt");
        expect(putResult.etag).toBe(true);

        const got = await sut.download("greetings/hello.txt");

        expect(got).not.toBeNull();
        expect(got!.key).toBe("greetings/hello.txt");
        await expect(got!.text()).resolves.toBe("hello cirrus");
    });

    test("list returns objects matching the given prefix", async () => {
        const sut = storage();

        await sut.upload("photos/a.jpg", new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
        await sut.upload("photos/b.jpg", new Uint8Array([4, 5, 6]).buffer as ArrayBuffer);
        await sut.upload("docs/readme.txt", new Uint8Array([7, 8, 9]).buffer as ArrayBuffer);

        const listed = await sut.list("photos/");
        const keys = listed.objects.map((object) => object.key).sort();

        expect(keys).toEqual(["photos/a.jpg", "photos/b.jpg"]);
    });

    test("delete removes the object", async () => {
        const sut = storage();

        await sut.upload("ephemeral.txt", new TextEncoder().encode("bye").buffer as ArrayBuffer);

        await expect(sut.download("ephemeral.txt")).resolves.not.toBeNull();

        await sut.delete("ephemeral.txt");

        await expect(sut.download("ephemeral.txt")).resolves.toBeNull();
    });

    test("download returns null for missing keys", async () => {
        const sut = storage();

        const got = await sut.download("does/not/exist.bin");

        expect(got).toBeNull();
    });
});
