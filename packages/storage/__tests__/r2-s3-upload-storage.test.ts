/**
 * `createR2UploadStorage` (R2's S3 API through `@visulima/storage`'s aws-light
 * provider) behind `createUploadHandler`, over an in-memory path-style S3 fake.
 */
import { Rest } from "@visulima/storage/handler/http/fetch";
import { createChunkedRestAdapter } from "@visulima/storage-client";
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
const ENDPOINT = "https://test.local/upload";

/** A plain-`http:` endpoint to `host`, the scheme the provider refuses except to a loopback host. */
const cleartext = (host: string): string => {
    const url = new URL(`https://${host}`);

    url.protocol = "http:";

    return url.href.replace(/\/$/u, "");
};

const r2Storage = (endpoint?: string) =>
    createR2UploadStorage({ accessKeyId: "id", accountId: "acct", bucket: "uploads", endpoint, path: "/upload", secretAccessKey: "secret" });

/** A fake bucket installed as `globalThis.fetch`, and a TUS route over it. */
const tusOver = (endpoint?: string, partsPerPage?: number): { s3: FakeR2S3; tus: TusDriver } => {
    const s3 = createFakeR2S3("uploads", { partsPerPage });

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
                // The bucket probe, then the multipart calls and the metadata object,
                // which a finished upload keeps. Since storage 2.0.32 the record is the
                // object's body, so it is read with GET.
                `HEAD ${base}`,
                `POST ${key}?uploads=`,
                `GET ${key}?uploadId=upload-1`,
                `PUT ${key}?partNumber=1&uploadId=upload-1`,
                `PUT ${key}?partNumber=2&uploadId=upload-1`,
                `POST ${key}?uploadId=upload-1`,
                `GET ${key}.META`,
                `PUT ${key}.META`,
            ]),
        );
        expect(s3.requests.every((request) => request.split(" ")[1]?.startsWith(base))).toBe(true);
        expect(s3.requests).not.toContain(`DELETE ${key}.META`);
    });

    it.each([
        "acct.eu.r2.cloudflarestorage.com",
        "/uploads",
        "file:///acct.r2.cloudflarestorage.com",
        // Cleartext to anything but a loopback host would carry the signed requests and the bytes in the open.
        cleartext("acct.r2.cloudflarestorage.com"),
        cleartext("10.0.0.5:9000"),
    ])("refuses the endpoint %j at construction with a VALIDATION_ERROR naming the expected form", (endpoint) => {
        expect.hasAssertions();

        expect(() => r2Storage(endpoint)).toThrow(
            expect.objectContaining({
                code: "VALIDATION_ERROR",
                message: expect.stringContaining(
                    "must be an absolute https:// URL such as https://<account>.r2.cloudflarestorage.com, or http:// to localhost",
                ),
            }),
        );
    });

    it.each([cleartext("localhost:9000"), cleartext("127.0.0.1:9000"), cleartext("[::1]:9000")])(
        "accepts the loopback endpoint %j, as a local S3 needs",
        async (endpoint) => {
            expect.hasAssertions();

            const { s3, tus } = tusOver(endpoint);

            await tus.create(10);

            expect(s3.requests.length).toBeGreaterThan(0);
            expect(s3.requests.every((request) => request.split(" ")[1]?.startsWith(`${endpoint}/uploads/`))).toBe(true);
        },
    );

    it.each([1000, 2])("stores a TUS upload of five parts intact, with ListParts paged at %i parts", async (partsPerPage) => {
        expect.hasAssertions();

        const { s3, tus } = tusOver(undefined, partsPerPage);
        const bytes = pattern(21 * MIB);
        const location = await tus.create(bytes.byteLength);
        const offsets: (string | null)[] = [];

        for (let offset = 0; offset < bytes.byteLength; offset += 5 * MIB) {
            // eslint-disable-next-line no-await-in-loop -- TUS chunks are sequential
            const response = await tus.patch(location, offset, bytes.slice(offset, offset + 5 * MIB));

            expect(response.status).toBe(204);

            offsets.push(response.headers.get("upload-offset"));
        }

        expect(offsets).toStrictEqual([5, 10, 15, 20, 21].map((mib) => String(mib * MIB)));
        // With a small page the provider has to follow the marker to see every part.
        expect(s3.requests.some((request) => request.includes("part-number-marker="))).toBe(partsPerPage < 5);
        expect(sameBytes(s3.object(keyOf(location)), bytes)).toBe(true);
    });

    it("stores a chunked-REST upload of three parts intact through upstream's Rest handler, refusing chunks out of order or sent twice (409)", async () => {
        expect.hasAssertions();

        const s3 = createFakeR2S3("uploads");

        vi.stubGlobal("fetch", s3.fetch);

        const driver = chunkedRest(new Rest({ storage: r2Storage() }));
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

    it.each([
        ["upstream's own Rest handler", (): ChunkedRestRoute => new Rest({ storage: r2Storage() })],
        ["createUploadHandler", (): ChunkedRestRoute => createUploadHandler({ protocol: "chunked-rest", silent: true, storage: r2Storage() })],
    ])("lets the bundled chunked-REST client complete an upload through %s, with no HEAD after the completing PATCH", async (_, route) => {
        expect.hasAssertions();

        const s3 = createFakeR2S3("uploads");
        const requests: string[] = [];
        // Built once the fake answers, since the provider probes its bucket from the constructor.
        let handler: ChunkedRestRoute | undefined;

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const request = input instanceof Request ? input : new Request(input, init);

            if (!request.url.startsWith(ENDPOINT)) {
                return s3.fetch(request);
            }

            if (handler === undefined) {
                throw new Error("the upload route is not built yet");
            }

            const response = await handler.fetch(request);

            requests.push(`${request.method} ${String(response.status)}`);

            return response;
        });

        handler = route();

        const bytes = pattern(MIB);
        const adapter = createChunkedRestAdapter({ chunkSize: bytes.byteLength, endpoint: ENDPOINT, retry: false });
        const result = await adapter.upload(new File([bytes], "a.bin", { type: "application/octet-stream" }));

        expect(result).toMatchObject({ bytesWritten: bytes.byteLength, status: "completed" });
        expect(requests).toStrictEqual(["POST 201", "HEAD 200", "PATCH 200"]);
        expect(sameBytes(s3.object(result.id), bytes)).toBe(true);

        // A finished upload keeps its state, so a later HEAD reports it complete.
        const head = await handler.fetch(new Request(`${ENDPOINT}/${result.id}`, { method: "HEAD" }));

        expect(head.status).toBe(200);
        expect(head.headers.get("x-upload-complete")).toBe("true");
        expect(head.headers.get("x-upload-offset")).toBe(String(bytes.byteLength));
    });

    describe("bucket objects the route never created (visulima/visulima#918)", () => {
        /** A fake bucket holding objects put there by something else, and a route of `protocol` over it. */
        const seeded = async (protocol: "chunked-rest" | "tus") => {
            const s3 = createFakeR2S3("uploads");

            vi.stubGlobal("fetch", s3.fetch);

            for (const key of ["payroll-2026", "report.pdf", "avatars/ceo"]) {
                // eslint-disable-next-line no-await-in-loop -- seeding one object at a time
                await s3.fetch(new Request(`https://acct.r2.cloudflarestorage.com/uploads/${key}`, { body: "SECRET", method: "PUT" }));
            }

            const route = createUploadHandler({ protocol, silent: true, storage: r2Storage() });

            return { route, s3 };
        };

        it.each(
            (["chunked-rest", "tus"] as const).flatMap((protocol) =>
                ["payroll-2026", "payroll-2026.pdf", "report.pdf", "avatars%2Fceo", "avatars%2fceo.png"].map((path) => [protocol, path] as const),
            ),
        )("answers HEAD over %s for /upload/%s with 404, without looking at the object", async (protocol, path) => {
            expect.hasAssertions();

            const { route, s3 } = await seeded(protocol);
            const before = s3.requests.length;
            const response = await route.fetch(new Request(`${ENDPOINT}/${path}`, { headers: { "Tus-Resumable": "1.0.0" }, method: "HEAD" }));

            expect(response.status).toBe(404);
            expect(response.headers.get("content-length")).not.toBe("6");
            // Only upload state is read: the bucket probe aside, nothing but a `.META` key is asked for.
            expect(s3.requests.slice(before).filter((request) => !request.endsWith("/uploads/") && !request.endsWith(".META"))).toStrictEqual([]);
        });

        it.each(["PATCH", "DELETE"])("answers a TUS %s for a bucket object with 404 and leaves it as it was", async (method) => {
            expect.hasAssertions();

            const { route, s3 } = await seeded("tus");
            const response = await route.fetch(
                new Request(`${ENDPOINT}/payroll-2026`, {
                    body: method === "PATCH" ? new Uint8Array(1) : undefined,
                    headers: { "Content-Type": "application/offset+octet-stream", "Tus-Resumable": "1.0.0", "Upload-Offset": "0" },
                    method,
                }),
            );

            expect(response.status).toBe(404);
            expect(s3.object("payroll-2026")).toStrictEqual(new TextEncoder().encode("SECRET"));
        });

        it("refuses a chunked-REST PUT whose name carries an escape, so it cannot reach a nested key", async () => {
            expect.hasAssertions();

            const { route, s3 } = await seeded("chunked-rest");
            const response = await route.fetch(
                new Request(`${ENDPOINT}/avatars%2Fceo.png`, { body: "evil", headers: { "content-length": "4", "content-type": "image/png" }, method: "PUT" }),
            );

            expect(response.status).toBe(400);
            expect(s3.object("avatars/ceo")).toStrictEqual(new TextEncoder().encode("SECRET"));
        });

        it("still answers HEAD for an upload the route created", async () => {
            expect.hasAssertions();

            const { route } = await seeded("chunked-rest");
            const driver = chunkedRest(route);
            const location = await driver.create(10);
            const head = await driver.head(location);

            expect(head.status).toBe(200);
            expect(head.headers.get("x-upload-offset")).toBe("0");
        });
    });
});
