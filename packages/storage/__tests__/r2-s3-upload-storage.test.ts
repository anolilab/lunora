/**
 * `createR2UploadStorage` (R2's S3 API through `@visulima/storage`'s aws-light
 * provider) behind `createUploadHandler`, over an in-memory path-style S3 fake.
 */
import { Rest } from "@visulima/storage/handler/http/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createR2UploadStorage } from "../src/r2-s3-upload-storage";
import { createUploadHandler } from "../src/upload-handler";
import { chunkedRest, uploadId } from "./chunked-rest-driver";
import type { FakeR2S3 } from "./fake-r2-s3";
import { createFakeR2S3 } from "./fake-r2-s3";
import type { TusDriver } from "./tus-driver";
import { tusDriver } from "./tus-driver";
import { pattern, sameBytes } from "./upload-pattern";

const MIB = 1024 * 1024;

const r2Storage = (endpoint?: string) =>
    createR2UploadStorage({ accessKeyId: "id", accountId: "acct", bucket: "uploads", endpoint, path: "/upload", secretAccessKey: "secret" });

/** A fake bucket installed as `globalThis.fetch`, and a TUS route over it. */
const tusOver = (endpoint?: string): { s3: FakeR2S3; tus: TusDriver } => {
    const s3 = createFakeR2S3("uploads");

    vi.stubGlobal("fetch", s3.fetch);

    return { s3, tus: tusDriver(createUploadHandler({ silent: true, storage: r2Storage(endpoint) })) };
};

const keyOf = (location: string): string => new URL(location).pathname.split("/").pop() ?? "";

describe("createR2UploadStorage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        ["the default account endpoint", undefined, "https://acct.r2.cloudflarestorage.com/uploads/"],
        ["an endpoint passed with a trailing slash", "https://acct.eu.r2.cloudflarestorage.com/", "https://acct.eu.r2.cloudflarestorage.com/uploads/"],
        ["an endpoint that already names the bucket", "https://acct.eu.r2.cloudflarestorage.com/uploads", "https://acct.eu.r2.cloudflarestorage.com/uploads/"],
    ])("stores a TUS upload of two parts intact under %s, every request naming the bucket once", async (_, endpoint, base) => {
        expect.hasAssertions();

        const { s3, tus } = tusOver(endpoint);
        const bytes = pattern(6 * MIB);
        const location = await tus.create(bytes.byteLength);

        await expect(tus.patch(location, 0, bytes.slice(0, 5 * MIB))).resolves.toHaveProperty("status", 204);

        const last = await tus.patch(location, 5 * MIB, bytes.slice(5 * MIB));

        expect(last.status).toBe(204);
        expect(last.headers.get("upload-offset")).toBe(String(bytes.byteLength));
        expect(sameBytes(s3.object(keyOf(location)), bytes)).toBe(true);

        const key = `${base}${keyOf(location)}`;

        expect(s3.requests).toStrictEqual(
            expect.arrayContaining([
                // The bucket probe, then the multipart calls and the metadata object.
                `HEAD ${base}`,
                `POST ${key}?uploads=`,
                `GET ${key}?uploadId=upload-1`,
                `PUT ${key}?partNumber=1&uploadId=upload-1`,
                `PUT ${key}?partNumber=2&uploadId=upload-1`,
                `POST ${key}?uploadId=upload-1`,
                `HEAD ${key}.META`,
                `PUT ${key}.META`,
                `DELETE ${key}.META`,
            ]),
        );
        expect(s3.requests.every((request) => request.split(" ")[1]?.startsWith(base))).toBe(true);
    });

    it("cannot store a third part: the provider reads back only the last part it listed (upstream)", async () => {
        expect.hasAssertions();

        // visulima/visulima#907: the aws-light XML parser keeps only the last
        // `<Part>` of a ListParts answer, so from the third part on the
        // provider computes its offset from one part and refuses the chunk.
        // When the third PATCH is stored, drop the notes on createR2UploadStorage.
        const { s3, tus } = tusOver();
        const bytes = pattern(11 * MIB);
        const location = await tus.create(bytes.byteLength);

        await expect(tus.patch(location, 0, bytes.slice(0, 5 * MIB))).resolves.toHaveProperty("status", 204);
        await expect(tus.patch(location, 5 * MIB, bytes.slice(5 * MIB, 10 * MIB))).resolves.toHaveProperty("status", 204);
        await expect(tus.patch(location, 10 * MIB, bytes.slice(10 * MIB))).resolves.toHaveProperty("status", 409);
        expect(s3.object(keyOf(location))).toBeUndefined();
    });

    it("refuses chunked REST at construction, and TUS and multipart are fine", () => {
        expect.hasAssertions();

        vi.stubGlobal("fetch", createFakeR2S3("uploads").fetch);

        expect(() => createUploadHandler({ protocol: "chunked-rest", silent: true, storage: r2Storage() })).toThrow(
            expect.objectContaining({
                code: "VALIDATION_ERROR",
                message: expect.stringMatching(/chunked REST is not supported over createR2UploadStorage.*404.*"tus".*createR2BindingUploadStorage/),
            }),
        );
        expect(() => createUploadHandler({ protocol: "tus", silent: true, storage: r2Storage() })).not.toThrow();
        expect(() => createUploadHandler({ protocol: "multipart", silent: true, storage: r2Storage() })).not.toThrow();
    });

    it("answers the chunk that completes a chunked-REST upload 404 upstream, which is why the route refuses the protocol", async () => {
        expect.hasAssertions();

        // Upstream's own `Rest` handler, since `createUploadHandler` refuses the
        // pairing. Out-of-order and repeated chunks are refused (409) without
        // being stored, but the completing chunk answers 404 though every byte is
        // stored (visulima/visulima#908): the provider deletes the upload's
        // metadata when it completes the multipart upload, before the handler
        // records the chunk. When this answers 200, drop the refusal above.
        const s3 = createFakeR2S3("uploads");

        vi.stubGlobal("fetch", s3.fetch);

        const driver = chunkedRest(new Rest({ storage: r2Storage() }));
        const bytes = pattern(6 * MIB);
        const location = await driver.create(bytes.byteLength);

        await expect(driver.patch(location, 5 * MIB, bytes.slice(5 * MIB))).resolves.toHaveProperty("status", 409);
        await expect(driver.patch(location, 0, bytes.slice(0, 5 * MIB))).resolves.toHaveProperty("status", 202);
        await expect(driver.patch(location, 0, bytes.slice(0, 5 * MIB))).resolves.toHaveProperty("status", 409);
        expect(s3.requests.filter((request) => request.includes("partNumber="))).toHaveLength(1);
        await expect(driver.patch(location, 5 * MIB, bytes.slice(5 * MIB))).resolves.toHaveProperty("status", 404);
        expect(sameBytes(s3.object(uploadId(location)), bytes)).toBe(true);
    });
});
