/**
 * The TUS rules `createUploadHandler` adds around `@visulima/storage`'s TUS
 * handler: `Upload-Checksum` refused where the provider verifies none, a capped
 * checksum buffer, and `Upload-Metadata` parsed as upstream parses it.
 */
import { createHash } from "node:crypto";

import { ERRORS } from "@visulima/storage";
import { Tus } from "@visulima/storage/handler/http/fetch";
import { MemoryStorage } from "@visulima/storage/provider/memory";
import { describe, expect, it, vi } from "vitest";

import { createR2BindingUploadStorage } from "../src/r2-binding-upload-storage";
import type { UploadSizeContext } from "../src/upload-handler";
import { createUploadHandler } from "../src/upload-handler";
import { uploadId } from "./chunked-rest-driver";
import { createFakeR2UploadBucket } from "./fake-r2-upload-bucket";
import { TUS_ENDPOINT as ENDPOINT, tusDriver } from "./tus-driver";

const MiB = 1024 * 1024;
const B64 = (value: string): string => Buffer.from(value).toString("base64");

describe("checksummed TUS chunks", () => {
    /** A memory provider that verifies md5 itself, so other algorithms are left to the handler's buffer. */
    class Md5MemoryStorage extends MemoryStorage {
        public override checksumTypes: string[] = ["md5"];
    }

    /** A checksummed first chunk: a `Content-Length` (which a stream body does not declare) and `Upload-Checksum`. */
    const checksummed = (length: number, checksum: string): Record<string, string> => {
        return { "Content-Length": String(length), "Upload-Checksum": `sha256 ${checksum}` };
    };

    /** A `length`-byte body that counts its reads. `highWaterMark: 0` keeps it from reading ahead of its consumer. */
    const countedBody = (length: number) => {
        const counter = { pulled: 0 };
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    const sent = counter.pulled * MiB;

                    counter.pulled += 1;
                    controller.enqueue(new Uint8Array(Math.min(MiB, length - sent)));

                    if (sent + MiB >= length) {
                        controller.close();
                    }
                },
            },
            { highWaterMark: 0 },
        );

        return { body, counter };
    };

    it.each([
        ["the memory provider", () => new MemoryStorage({ path: "/upload" })],
        ["createR2BindingUploadStorage", () => createR2BindingUploadStorage(createFakeR2UploadBucket())],
    ] as const)("refuses Upload-Checksum over %s, which verifies none (400), before the gate and without reading the body", async (_name, storage) => {
        expect.hasAssertions();

        const authorize = vi.fn<() => boolean>(() => true);
        const route = createUploadHandler({ authorize, storage: storage() });
        const location = await tusDriver(route).create(2 * MiB, { filename: "sum.bin" });

        authorize.mockClear();

        const { body, counter } = countedBody(MiB);
        const response = await tusDriver(route).patch(location, 0, body, checksummed(MiB, "AAAA"));

        expect(response.status).toBe(400);
        expect(response.headers.get("tus-resumable")).toBe("1.0.0");
        await expect(response.json()).resolves.toMatchObject({ error: { code: ERRORS.UNSUPPORTED_CHECKSUM_ALGORITHM } });
        expect(counter.pulled).toBe(0);
        expect(authorize).not.toHaveBeenCalled();
    });

    it("drops Tus-Checksum-Algorithm from OPTIONS on a route that refuses checksums, and keeps it where they are verified", async () => {
        expect.hasAssertions();

        const refusing = await createUploadHandler({ silent: true, storage: new MemoryStorage({ path: "/upload" }) }).fetch(
            new Request(ENDPOINT, { method: "OPTIONS" }),
        );
        const verifying = await createUploadHandler({ silent: true, storage: new Md5MemoryStorage({ path: "/upload" }) }).fetch(
            new Request(ENDPOINT, { method: "OPTIONS" }),
        );

        expect(refusing.status).toBe(204);
        expect(refusing.headers.has("tus-checksum-algorithm")).toBe(false);
        expect(refusing.headers.get("tus-resumable")).toBe("1.0.0");
        expect(verifying.headers.get("tus-checksum-algorithm")).toContain("sha256");

        const extensions = (response: Response): string[] => (response.headers.get("tus-extension") ?? "").split(",");

        expect(extensions(verifying)).toContain("checksum");
        expect(extensions(refusing)).toStrictEqual(extensions(verifying).filter((extension) => extension !== "checksum"));
    });

    it.each(["HEAD", "DELETE", "OPTIONS"])("lets %s carry Upload-Checksum through, as upstream ignores it there", async (method) => {
        expect.hasAssertions();

        const authorize = vi.fn<() => boolean>(() => true);
        const route = createUploadHandler({ authorize, silent: true, storage: new MemoryStorage({ path: "/upload" }) });
        const tus = tusDriver(route);
        const plain = await tus.create(4, { filename: "plain.bin" });
        const summed = await tus.create(4, { filename: "summed.bin" });
        const send = async (url: string, headers: Record<string, string>): Promise<Response> =>
            route.fetch(new Request(method === "OPTIONS" ? ENDPOINT : url, { headers: { "Tus-Resumable": "1.0.0", ...headers }, method }));

        authorize.mockClear();

        const without = await send(plain, {});
        const withChecksum = await send(summed, { "Upload-Checksum": "sha256 AAAA" });

        expect(withChecksum.status).toBe(without.status);
        expect(withChecksum.status).toBeLessThan(300);
        expect(authorize).toHaveBeenCalledTimes(2);
    });

    it("refuses a buffered checksummed chunk just over 16 MiB (413) before reading any of it", async () => {
        expect.hasAssertions();

        const route = createUploadHandler({ silent: true, storage: new Md5MemoryStorage({ path: "/upload" }) });
        const tus = tusDriver(route);
        const location = await tus.create(32 * MiB, { filename: "big.bin" });
        const length = 16 * MiB + 1;
        const { body, counter } = countedBody(length);

        const response = await tus.patch(location, 0, body, checksummed(length, "AAAA"));

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toMatchObject({ error: { message: expect.stringMatching(/at most 16777216 bytes/) } });
        expect(counter.pulled).toBe(0);
        await expect(tus.offset(location)).resolves.toBe(0);
    });

    it("verifies and stores a buffered checksummed 5 MiB chunk", async () => {
        expect.hasAssertions();

        const route = createUploadHandler({ silent: true, storage: new Md5MemoryStorage({ path: "/upload" }) });
        const bytes = new Uint8Array(5 * MiB).fill(42);
        const tus = tusDriver(route);
        const location = await tus.create(bytes.byteLength, { filename: "five.bin" });
        const checksum = createHash("sha256").update(bytes).digest("base64");

        const response = await tus.patch(location, 0, bytes, checksummed(bytes.byteLength, checksum));

        expect(response.status).toBe(204);
        expect(Number(response.headers.get("upload-offset"))).toBe(bytes.byteLength);
    });
});

describe("tus Upload-Metadata, parsed as @visulima/storage parses it", () => {
    const IMAGE_CAP = MiB;

    /** A route that caps images at 1 MiB and records the type `maxFileSizeFor` saw. */
    const cappedRoute = (storage: MemoryStorage) => {
        const seen: string[] = [];
        const authorize = vi.fn<() => boolean>(() => true);
        const route = createUploadHandler({
            authorize,
            maxFileSizeFor: ({ contentType }: UploadSizeContext) => {
                seen.push(contentType);

                return contentType.startsWith("image/") ? IMAGE_CAP : undefined;
            },
            storage,
        });

        return { authorize, route, seen };
    };

    const create = async (route: { fetch: (request: Request) => Promise<Response> }, metadata: string, length = 40 * MiB): Promise<Response> =>
        route.fetch(
            new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(length), "Upload-Metadata": metadata }, method: "POST" }),
        );

    it.each([
        ["a `, ` separator", `filename ${B64("a.png")}, filetype ${B64("image/png")}`],
        ["mixed type keys, mimeType winning after a `, `", `filetype ${B64("video/mp4")}, mimeType ${B64("image/png")}`],
        ["padding around every pair", `  filename ${B64("a.png")} ,  type ${B64("image/png")}  `],
    ])("caps an image declared with %s at the image cap (413)", async (_label, metadata) => {
        expect.hasAssertions();

        const { route, seen } = cappedRoute(new MemoryStorage({ path: "/upload" }));

        await expect(create(route, metadata)).resolves.toHaveProperty("status", 413);
        expect(seen).toStrictEqual(["image/png"]);
    });

    it.each([
        ["a duplicate key", `filetype ${B64("video/mp4")},filetype ${B64("image/png")}`, /duplicate key "filetype"/],
        ["a pair of three parts", `filetype ${B64("image/png")} extra`, /malformed key-value pair/],
        ["a value that is not base64", "filetype image/png!", /value of "filetype" is not base64/],
        ["url-safe base64", `filename ${Buffer.from("??>").toString("base64url")}`, /value of "filename" is not base64/],
        ["a reserved key", `uploadConcat ${B64("partial")}`, /reserved key "uploadConcat"/],
    ])("refuses Upload-Metadata with %s (400) before authorize and maxFileSizeFor", async (_label, metadata, message) => {
        expect.hasAssertions();

        const { authorize, route, seen } = cappedRoute(new MemoryStorage({ path: "/upload" }));
        const response = await create(route, metadata, 10);

        expect(response.status).toBe(400);
        expect(response.headers.get("tus-resumable")).toBe("1.0.0");
        await expect(response.json()).resolves.toMatchObject({ error: { message: expect.stringMatching(message) } });
        expect(authorize).not.toHaveBeenCalled();
        expect(seen).toStrictEqual([]);
    });

    it("refuses an invalid Upload-Metadata on a PATCH too, where upstream also reads it", async () => {
        expect.hasAssertions();

        const { authorize, route } = cappedRoute(new MemoryStorage({ path: "/upload" }));
        const tus = tusDriver(route);
        const location = await tus.create(4, { filename: "a.bin" });

        authorize.mockClear();

        const response = await tus.patch(location, 0, new Uint8Array(4), { "Upload-Metadata": "a b c" });

        expect(response.status).toBe(400);
        // Upstream answers this PATCH 400 too: only the gate shows the route refused it.
        expect(authorize).not.toHaveBeenCalled();
        await expect(tus.offset(location)).resolves.toBe(0);
    });

    // Lunora's parse and upstream's must agree on every header: the same
    // status, and on a create, the type `maxFileSizeFor` saw is the type
    // stored.
    it.each([
        `filetype ${B64("image/png")}`,
        `filename ${B64("a.png")}, filetype ${B64("image/png")}`,
        `filetype ${B64("video/mp4")}, mimeType ${B64("image/png")}`,
        `type ${B64("text/plain")},filetype ${B64("image/png")}`,
        `mimeType ${B64("")},filetype ${B64("image/png")}`,
        `mimeType,filetype ${B64("image/png")}`,
        ` , ,filename ${B64("x")}`,
        "",
        "   ",
        "flag",
        `filetype ${B64("image/png")},filetype ${B64("image/png")}`,
        "a b c",
        "filetype %%%",
        `partialIds ${B64("x")}`,
        `_writeClaim ${B64("x")}`,
        `filename ${Buffer.from("??>").toString("base64url")}`,
    ])("agrees with @visulima/storage on %j", async (metadata) => {
        expect.hasAssertions();

        const upstreamStorage = new MemoryStorage({ path: "/upload" });
        const upstream = await new Tus({ storage: upstreamStorage }).fetch(
            new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "10", "Upload-Metadata": metadata }, method: "POST" }),
        );
        const lunoraStorage = new MemoryStorage({ path: "/upload" });
        const { route, seen } = cappedRoute(lunoraStorage);
        const lunora = await create(route, metadata, 10);

        expect(lunora.status).toBe(upstream.status);

        // A refusal carries upstream's error code too (`BadRequestError`, from `http-errors`).
        const errorCode = async (response: Response): Promise<string | undefined> => {
            if (response.status === 201) {
                return undefined;
            }

            const body = await response.clone().json<{ error?: { code?: string } }>();

            return body.error?.code;
        };

        await expect(errorCode(lunora)).resolves.toBe(await errorCode(upstream));

        const storedType = async (storage: MemoryStorage, response: Response): Promise<string | undefined> => {
            if (response.status !== 201) {
                return undefined;
            }

            const file = await storage.getMeta(uploadId(response.headers.get("location") ?? ""));

            return file.contentType;
        };
        const upstreamType = await storedType(upstreamStorage, upstream);

        await expect(storedType(lunoraStorage, lunora)).resolves.toBe(upstreamType);
        expect(seen).toStrictEqual(upstreamType === undefined ? [] : [upstreamType]);
    });
});
