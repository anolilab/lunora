/**
 * `createR2UploadStorage` (R2's S3 API through `@visulima/storage`'s aws-light
 * provider) behind `createUploadHandler`, over an in-memory path-style S3 fake.
 */
import { Rest } from "@visulima/storage/handler/http/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createR2UploadStorage } from "../src/r2-s3-upload-storage";
import { createUploadHandler } from "../src/upload-handler";
import type { ChunkedRestRoute } from "./chunked-rest-driver";
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
        [
            "a virtual-hosted endpoint, whose host names the bucket",
            "https://uploads.acct.r2.cloudflarestorage.com",
            "https://uploads.acct.r2.cloudflarestorage.com/",
        ],
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

    it.each(["acct.eu.r2.cloudflarestorage.com", "/uploads", "file:///acct.r2.cloudflarestorage.com"])(
        "refuses the endpoint %j at construction with a VALIDATION_ERROR naming the expected form",
        (endpoint) => {
            expect.hasAssertions();

            expect(() => r2Storage(endpoint)).toThrow(
                expect.objectContaining({
                    code: "VALIDATION_ERROR",
                    message: expect.stringContaining("must be an absolute URL such as https://<account>.r2.cloudflarestorage.com"),
                }),
            );
        },
    );

    it("stores a TUS upload of three parts intact", async () => {
        expect.hasAssertions();

        const { s3, tus } = tusOver();
        const bytes = pattern(11 * MIB);
        const location = await tus.create(bytes.byteLength);

        const offsets: (string | null)[] = [];

        for (const offset of [0, 5 * MIB, 10 * MIB]) {
            // eslint-disable-next-line no-await-in-loop -- TUS chunks are sequential
            const response = await tus.patch(location, offset, bytes.slice(offset, offset + 5 * MIB));

            expect(response.status).toBe(204);

            offsets.push(response.headers.get("upload-offset"));
        }

        expect(offsets).toStrictEqual([String(5 * MIB), String(10 * MIB), String(bytes.byteLength)]);
        expect(sameBytes(s3.object(keyOf(location)), bytes)).toBe(true);
    });

    it.each([
        ["upstream's own Rest handler", (): ChunkedRestRoute => new Rest({ storage: r2Storage() })],
        ["createUploadHandler", (): ChunkedRestRoute => createUploadHandler({ protocol: "chunked-rest", silent: true, storage: r2Storage() })],
    ])("stores a chunked-REST upload of three parts intact through %s, refusing chunks out of order or sent twice (409)", async (_, route) => {
        expect.hasAssertions();

        const s3 = createFakeR2S3("uploads");

        vi.stubGlobal("fetch", s3.fetch);

        const driver = chunkedRest(route());
        const bytes = pattern(11 * MIB);
        const chunk = (offset: number): Uint8Array<ArrayBuffer> => bytes.slice(offset, offset + 5 * MIB);
        const location = await driver.create(bytes.byteLength);

        await expect(driver.patch(location, 5 * MIB, chunk(5 * MIB))).resolves.toHaveProperty("status", 409);
        await expect(driver.patch(location, 0, chunk(0))).resolves.toHaveProperty("status", 202);
        await expect(driver.patch(location, 0, chunk(0))).resolves.toHaveProperty("status", 409);
        // Neither refused chunk reached the bucket.
        expect(s3.requests.filter((request) => request.includes("partNumber="))).toHaveLength(1);
        await expect(driver.patch(location, 5 * MIB, chunk(5 * MIB))).resolves.toHaveProperty("status", 202);

        const last = await driver.patch(location, 10 * MIB, chunk(10 * MIB));

        expect(last.status).toBe(200);
        expect(last.headers.get("x-upload-complete")).toBe("true");
        expect(sameBytes(s3.object(uploadId(location)), bytes)).toBe(true);
    });
});
