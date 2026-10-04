/**
 * `createR2UploadStorage` (R2's S3 API through `@visulima/storage`'s aws-light
 * provider) behind `createUploadHandler`, over an in-memory path-style S3 fake.
 */
import { Rest } from "@visulima/storage/handler/http/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createR2UploadStorage, createUploadHandler } from "../src/upload-handler";
import { chunkedRest, uploadId } from "./chunked-rest-driver";
import type { FakeR2S3 } from "./fake-r2-s3";
import { createFakeR2S3 } from "./fake-r2-s3";

const MIB = 1024 * 1024;
const ENDPOINT = "https://test.local/upload";

const pattern = (size: number): Uint8Array<ArrayBuffer> => new Uint8Array(size).map((_, index) => index % 251);

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && Buffer.from(a).equals(Buffer.from(b));

/** A fake bucket installed as `globalThis.fetch`, and a TUS route over it. */
const routeOver = (endpoint?: string): { handler: ReturnType<typeof createUploadHandler>; s3: FakeR2S3 } => {
    const s3 = createFakeR2S3("uploads");

    vi.stubGlobal("fetch", s3.fetch);

    const storage = createR2UploadStorage({ accessKeyId: "id", accountId: "acct", bucket: "uploads", endpoint, path: "/upload", secretAccessKey: "secret" });

    return { handler: createUploadHandler({ silent: true, storage }), s3 };
};

const tusCreate = async (handler: ReturnType<typeof createUploadHandler>, length: number): Promise<string> => {
    const created = await handler.fetch(new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(length) }, method: "POST" }));

    expect(created.status).toBe(201);

    return created.headers.get("location") ?? "";
};

const tusPatch = async (handler: ReturnType<typeof createUploadHandler>, location: string, offset: number, chunk: Uint8Array<ArrayBuffer>): Promise<Response> =>
    handler.fetch(
        new Request(location, {
            body: chunk,
            headers: {
                "Content-Length": String(chunk.byteLength),
                "Content-Type": "application/offset+octet-stream",
                "Tus-Resumable": "1.0.0",
                "Upload-Offset": String(offset),
            },
            method: "PATCH",
        }),
    );

const keyOf = (location: string): string => new URL(location).pathname.split("/").pop() ?? "";

describe("createR2UploadStorage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("addresses the bucket in the path of the account endpoint, or of the endpoint passed", async () => {
        expect.hasAssertions();

        for (const endpoint of [undefined, "https://acct.eu.r2.cloudflarestorage.com/"]) {
            const { handler, s3 } = routeOver(endpoint);

            // eslint-disable-next-line no-await-in-loop -- one endpoint at a time, each with its own fetch stub
            await tusCreate(handler, 10);

            expect(s3.requests.length).toBeGreaterThan(0);
            expect(s3.requests.every((request) => request.split(" ")[1]?.startsWith("/uploads/"))).toBe(true);
        }
    });

    it("stores a TUS upload of two parts intact", async () => {
        expect.hasAssertions();

        const { handler, s3 } = routeOver();
        const bytes = pattern(6 * MIB);
        const location = await tusCreate(handler, bytes.byteLength);

        await expect(tusPatch(handler, location, 0, bytes.slice(0, 5 * MIB))).resolves.toHaveProperty("status", 204);

        const last = await tusPatch(handler, location, 5 * MIB, bytes.slice(5 * MIB));

        expect(last.status).toBe(204);
        expect(last.headers.get("upload-offset")).toBe(String(bytes.byteLength));
        expect(sameBytes(s3.object(keyOf(location)), bytes)).toBe(true);
    });

    it("cannot store a third part: the provider reads back only the last part it listed (upstream)", async () => {
        expect.hasAssertions();

        // `@visulima/storage` 2.0.27's aws-light XML parser keeps only the last
        // `<Part>` of a ListParts answer, so from the third part on the
        // provider computes its offset from one part and refuses the chunk.
        // When this starts passing with the third PATCH stored, drop the
        // "broken upstream" notes on createR2UploadStorage.
        const { handler, s3 } = routeOver();
        const bytes = pattern(11 * MIB);
        const location = await tusCreate(handler, bytes.byteLength);

        await expect(tusPatch(handler, location, 0, bytes.slice(0, 5 * MIB))).resolves.toHaveProperty("status", 204);
        await expect(tusPatch(handler, location, 5 * MIB, bytes.slice(5 * MIB, 10 * MIB))).resolves.toHaveProperty("status", 204);
        await expect(tusPatch(handler, location, 10 * MIB, bytes.slice(10 * MIB))).resolves.toHaveProperty("status", 409);
        expect(s3.object(keyOf(location))).toBeUndefined();
    });

    it("refuses chunked REST at construction, and TUS and multipart are fine", () => {
        expect.hasAssertions();

        vi.stubGlobal("fetch", createFakeR2S3("uploads").fetch);

        const s3 = () => createR2UploadStorage({ accessKeyId: "id", accountId: "acct", bucket: "uploads", path: "/upload", secretAccessKey: "secret" });

        expect(() => createUploadHandler({ protocol: "chunked-rest", silent: true, storage: s3() })).toThrow(
            expect.objectContaining({
                code: "VALIDATION_ERROR",
                message: expect.stringMatching(/chunked REST is not supported over createR2UploadStorage.*404.*"tus".*createR2BindingUploadStorage/),
            }),
        );
        expect(() => createUploadHandler({ protocol: "tus", silent: true, storage: s3() })).not.toThrow();
        expect(() => createUploadHandler({ protocol: "multipart", silent: true, storage: s3() })).not.toThrow();
    });

    it("answers the chunk that completes a chunked-REST upload 404 upstream, which is why the route refuses the protocol", async () => {
        expect.hasAssertions();

        // Upstream's own `Rest` handler, since `createUploadHandler` refuses the
        // pairing. Out-of-order and repeated chunks are refused (409) without
        // being stored, but the completing chunk answers 404 though every byte
        // is stored: the provider deletes the upload's metadata when it completes
        // the multipart upload, before the handler records the chunk. When this
        // answers 200, drop the construction-time refusal above.
        const s3 = createFakeR2S3("uploads");

        vi.stubGlobal("fetch", s3.fetch);

        const storage = createR2UploadStorage({ accessKeyId: "id", accountId: "acct", bucket: "uploads", path: "/upload", secretAccessKey: "secret" });
        const driver = chunkedRest(new Rest({ storage }));
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
