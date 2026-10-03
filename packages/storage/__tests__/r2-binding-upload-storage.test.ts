/**
 * The binding-backed upload provider, driven through `createUploadHandler` over
 * an in-memory R2 binding (see `fake-r2-upload-bucket.ts`), plus the handler's
 * per-request size cap.
 */
import { createTusAdapter, UploadControl } from "@visulima/storage-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { R2UploadBucket } from "../src/r2-binding-upload-storage";
import { createR2BindingUploadStorage, R2_PART_SIZE } from "../src/r2-binding-upload-storage";
import type { UploadSizeContext } from "../src/upload-handler";
import { createUploadHandler } from "../src/upload-handler";
import { createFakeR2UploadBucket } from "./fake-r2-upload-bucket";

const ENDPOINT = "https://test.local/upload";
const STATE_PREFIX = "_lunora/uploads/";
const B64 = (value: string): string => Buffer.from(value).toString("base64");

/** Deterministic, position-dependent bytes, so a misplaced chunk changes the result. */
const pattern = (length: number): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(length);

    for (let index = 0; index < length; index += 1) {
        bytes[index] = (index * 31 + 7) % 251;
    }

    return bytes;
};

/** Byte equality without a structural diff over megabytes (which is what makes `toStrictEqual` crawl). */
const sameBytes = (actual: Uint8Array | undefined, expected: Uint8Array): boolean => actual !== undefined && Buffer.from(actual).equals(Buffer.from(expected));

const handlerOver = (bucket: R2UploadBucket) => createUploadHandler({ silent: true, storage: createR2BindingUploadStorage(bucket) });

type Handler = ReturnType<typeof handlerOver>;

const tus = (handler: Handler) => {
    return {
        create: async (length: number, name = "file.bin", filetype = "application/octet-stream"): Promise<string> => {
            const response = await handler.fetch(
                new Request(ENDPOINT, {
                    headers: {
                        "Tus-Resumable": "1.0.0",
                        "Upload-Length": String(length),
                        "Upload-Metadata": `filename ${B64(name)},filetype ${B64(filetype)}`,
                    },
                    method: "POST",
                }),
            );

            expect(response.status).toBe(201);

            const location = response.headers.get("location") ?? "";

            return location.startsWith("http") ? location : `https://test.local${location}`;
        },
        delete: async (location: string): Promise<Response> =>
            handler.fetch(new Request(location, { headers: { "Tus-Resumable": "1.0.0" }, method: "DELETE" })),
        head: async (location: string): Promise<Response> => handler.fetch(new Request(location, { headers: { "Tus-Resumable": "1.0.0" }, method: "HEAD" })),
        patch: async (location: string, offset: number, body: BodyInit): Promise<Response> =>
            handler.fetch(
                new Request(location, {
                    body,
                    headers: { "Content-Type": "application/offset+octet-stream", "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset) },
                    method: "PATCH",
                    // A stream body needs half-duplex in Node's fetch.
                    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
                }),
            ),
    };
};

/** Upload `bytes` from `from` in chunks of `chunkSize`, asserting each PATCH's offset. */
const sendChunks = async (
    driver: ReturnType<typeof tus>,
    location: string,
    bytes: Uint8Array<ArrayBuffer>,
    chunkSize: number,
    from = 0,
    until = bytes.byteLength,
) => {
    let offset = from;

    while (offset < until) {
        const chunk = bytes.slice(offset, Math.min(offset + chunkSize, until));
        // eslint-disable-next-line no-await-in-loop -- TUS chunks are sequential
        const response = await driver.patch(location, offset, chunk);

        offset += chunk.byteLength;

        expect([200, 204]).toContain(response.status);
        expect(Number(response.headers.get("upload-offset"))).toBe(offset);
    }
};

/** The `Upload-Offset` a response reports. */
const offsetOf = async (response: Promise<Response>): Promise<string | null> => {
    const resolved = await response;

    return resolved.headers.get("upload-offset");
};

const storedObject = (bucket: ReturnType<typeof createFakeR2UploadBucket>, location: string) => bucket.objects.get(location.split("/").pop() ?? "");

const stateKeys = (bucket: ReturnType<typeof createFakeR2UploadBucket>): string[] => [...bucket.objects.keys()].filter((key) => key.startsWith(STATE_PREFIX));

describe(createR2BindingUploadStorage, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("uploads in odd-sized chunks under 5 MiB, coalescing them into equal 5 MiB parts and a short last part", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const total = 2 * R2_PART_SIZE + 123_457;
        const bytes = pattern(total);
        const location = await driver.create(total, "video.mp4", "video/mp4");

        await sendChunks(driver, location, bytes, 1_000_003);

        const object = storedObject(bucket, location);

        expect(sameBytes(object?.bytes, bytes)).toBe(true);
        expect(object?.contentType).toBe("video/mp4");
        // Two full parts, then the remainder: R2's equal-size rule holds.
        expect(bucket.partSizes).toStrictEqual([[R2_PART_SIZE, R2_PART_SIZE, 123_457]]);
        expect(bucket.openUploads.size).toBe(0);

        // Only the (compacted) state object is left: every buffered segment is gone.
        expect(stateKeys(bucket)).toStrictEqual([`${STATE_PREFIX}${location.split("/").pop() ?? ""}.json`]);

        const head = await driver.head(location);

        expect(head.headers.get("upload-offset")).toBe(String(total));
        expect(head.headers.get("upload-length")).toBe(String(total));
    });

    it("writes a file smaller than one part with a single put, never starting a multipart upload", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const bytes = pattern(300_001);
        const location = await driver.create(bytes.byteLength);

        await sendChunks(driver, location, bytes, 64 * 1024 + 3);

        expect(sameBytes(storedObject(bucket, location)?.bytes, bytes)).toBe(true);
        expect(bucket.partSizes).toStrictEqual([]);
    });

    it("finishes a file that is an exact multiple of the part size without an empty last part", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const bytes = pattern(2 * R2_PART_SIZE);
        const location = await driver.create(bytes.byteLength);

        await sendChunks(driver, location, bytes, 3 * 1024 * 1024);

        expect(sameBytes(storedObject(bucket, location)?.bytes, bytes)).toBe(true);
        expect(bucket.partSizes).toStrictEqual([[R2_PART_SIZE, R2_PART_SIZE]]);
    });

    it("finishes a zero-byte upload at creation", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const location = await driver.create(0, "empty.txt");

        expect(sameBytes(storedObject(bucket, location)?.bytes, new Uint8Array(0))).toBe(true);
        await expect(offsetOf(driver.head(location))).resolves.toBe("0");
    });

    it("resumes on a new provider instance (an isolate hop) from the offset stored in the bucket", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const total = R2_PART_SIZE + 2_000_000;
        const bytes = pattern(total);
        const first = tus(handlerOver(bucket));
        const location = await first.create(total);

        // 6.2 MB lands on isolate A: one part stored, the rest buffered as a segment.
        await sendChunks(first, location, bytes, 1_234_567, 0, 6_200_000);

        // Isolate B: a fresh provider and handler over the same binding.
        const second = tus(handlerOver(bucket));
        const head = await second.head(location);

        expect(head.status).toBe(200);
        expect(Number(head.headers.get("upload-offset"))).toBe(6_200_000);

        await sendChunks(second, location, bytes, 777_777, 6_200_000);

        expect(sameBytes(storedObject(bucket, location)?.bytes, bytes)).toBe(true);
        expect(bucket.partSizes).toStrictEqual([[R2_PART_SIZE, 2_000_000]]);
    });

    it("drives a whole upload from the TUS client with its default 1 MiB chunks", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const handler = handlerOver(bucket);

        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);

            return handler.fetch(new Request(`https://test.local${url.pathname}${url.search}`, request));
        });

        const bytes = pattern(R2_PART_SIZE + 1_500_000);
        const adapter = createTusAdapter({ control: new UploadControl(), endpoint: ENDPOINT });
        const result = await adapter.upload(new File([bytes], "client.bin", { type: "application/octet-stream" }));

        expect(result.bytesWritten).toBe(bytes.byteLength);
        expect([...bucket.objects.values()].some((object) => object.bytes.byteLength === bytes.byteLength)).toBe(true);
        expect(bucket.partSizes).toStrictEqual([[R2_PART_SIZE, 1_500_000]]);
    });

    it("answers a PATCH at the wrong offset with 409 and leaves the upload as it was", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const bytes = pattern(1_000_000);
        const location = await driver.create(bytes.byteLength);

        await sendChunks(driver, location, bytes, 400_000, 0, 400_000);

        // A replayed chunk, and a skipped-ahead one.
        await expect(driver.patch(location, 0, bytes.slice(0, 400_000))).resolves.toHaveProperty("status", 409);
        await expect(driver.patch(location, 800_000, bytes.slice(800_000))).resolves.toHaveProperty("status", 409);
        await expect(offsetOf(driver.head(location))).resolves.toBe("400000");

        await sendChunks(driver, location, bytes, 400_000, 400_000);

        expect(sameBytes(storedObject(bucket, location)?.bytes, bytes)).toBe(true);
    });

    it("refuses a second PATCH while another one for the same upload is still streaming (409)", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const bytes = pattern(600_000);
        const location = await driver.create(bytes.byteLength);

        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let pulled = 0;
        const slowBody = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (pulled === 0) {
                    pulled += 1;
                    controller.enqueue(bytes.slice(0, 300_000));

                    return;
                }

                await gate;
                controller.enqueue(bytes.slice(300_000));
                controller.close();
            },
        });

        const inFlight = driver.patch(location, 0, slowBody);

        // Let the first request take the lease and start reading.
        await vi.waitFor(() => {
            expect(pulled).toBe(1);
        });

        const concurrent = await driver.patch(location, 0, bytes);

        expect(concurrent.status).toBe(409);

        release?.();

        const finished = await inFlight;

        expect(finished.status).toBe(200);
        expect(sameBytes(storedObject(bucket, location)?.bytes, bytes)).toBe(true);
    });

    it("lets a new request take over a lease that expired (a writer that died mid-request)", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const bytes = pattern(500_000);
        const location = await driver.create(bytes.byteLength);
        const id = location.split("/").pop() ?? "";
        const stateKey = `${STATE_PREFIX}${id}.json`;
        const stored = bucket.objects.get(stateKey);
        const state = JSON.parse(new TextDecoder().decode(stored?.bytes)) as { upload: Record<string, unknown> };

        // A lock left behind by an isolate that never came back.
        state.upload.lock = { expiresAt: Date.now() - 1, token: "dead-writer" };
        await bucket.put(stateKey, JSON.stringify(state));

        await sendChunks(driver, location, bytes, 500_000);

        expect(sameBytes(storedObject(bucket, location)?.bytes, bytes)).toBe(true);
    });

    it("keeps the bytes that arrived before the client dropped, so the upload resumes from there", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const total = R2_PART_SIZE + 1_000_000;
        const bytes = pattern(total);
        const location = await driver.create(total);
        const received = R2_PART_SIZE + 250_000;
        let sent = false;
        const droppingBody = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent) {
                    controller.error(new Error("connection reset"));

                    return;
                }

                sent = true;
                controller.enqueue(bytes.slice(0, received));
            },
        });

        const dropped = await driver.patch(location, 0, droppingBody);

        expect(dropped.status).toBeGreaterThanOrEqual(400);
        await expect(offsetOf(driver.head(location))).resolves.toBe(String(received));

        await sendChunks(driver, location, bytes, 500_000, received);

        expect(sameBytes(storedObject(bucket, location)?.bytes, bytes)).toBe(true);
    });

    it("refuses a chunk that runs past the declared length (413) without moving the offset", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const location = await driver.create(1000);

        await expect(driver.patch(location, 0, pattern(1001))).resolves.toHaveProperty("status", 413);
        await expect(offsetOf(driver.head(location))).resolves.toBe("0");
    });

    it("aborts an unfinished upload on DELETE and removes everything it stored", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const bytes = pattern(R2_PART_SIZE + 700_000);
        const location = await driver.create(2 * R2_PART_SIZE);

        await sendChunks(driver, location, bytes, 2_000_000);

        // A part is stored on an open multipart upload, and a segment waits.
        expect(bucket.openUploads.size).toBe(1);
        expect(stateKeys(bucket).length).toBeGreaterThan(1);

        const deleted = await driver.delete(location);

        expect(deleted.status).toBe(204);
        expect(bucket.openUploads.size).toBe(0);
        expect([...bucket.objects.keys()]).toStrictEqual([]);
        await expect(driver.head(location)).resolves.toHaveProperty("status", 404);
    });

    it("refuses to delete a finished upload through the route", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const location = await driver.create(4);

        await sendChunks(driver, location, pattern(4), 4);

        await expect(driver.delete(location)).resolves.toHaveProperty("status", 400);
        expect(sameBytes(storedObject(bucket, location)?.bytes, pattern(4))).toBe(true);
    });

    it("advertises only the TUS extensions it can honor", async () => {
        expect.hasAssertions();

        const response = await handlerOver(createFakeR2UploadBucket()).fetch(new Request(ENDPOINT, { method: "OPTIONS" }));
        const extensions = response.headers.get("tus-extension")?.split(",") ?? [];

        expect(extensions).toContain("creation");
        expect(extensions).toContain("termination");
        expect(extensions).not.toContain("creation-defer-length");
        expect(extensions).not.toContain("concatenation");
        expect(extensions).not.toContain("checksum");
    });

    it("stores a multipart-form upload in one request", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const handler = createUploadHandler({ protocol: "multipart", silent: true, storage: createR2BindingUploadStorage(bucket) });
        const bytes = pattern(70_000);
        const form = new FormData();

        form.append("file", new Blob([bytes], { type: "image/png" }), "photo.png");

        const response = await handler.fetch(new Request(ENDPOINT, { body: form, method: "POST" }));

        expect(response.status).toBe(200);

        const stored = [...bucket.objects.entries()].find(([key]) => !key.startsWith(STATE_PREFIX));

        expect(sameBytes(stored?.[1].bytes, bytes)).toBe(true);
        expect(stored?.[1].contentType).toBe("image/png");
    });

    it("keeps metadata updates and upload progress apart under the state object's compare-and-swap", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const storage = createR2BindingUploadStorage(bucket);
        const file = await storage.create({ metadata: { name: "notes.txt" }, size: 10 });

        await storage.write({ body: new Blob([pattern(4)]).stream() as never, contentLength: 4, id: file.id, start: 0 });

        const updated = await storage.update({ id: file.id }, { bytesWritten: 0, metadata: { label: "draft" }, size: 99 });

        expect(updated.bytesWritten).toBe(4);
        expect(updated.size).toBe(10);
        expect(updated.metadata).toStrictEqual({ label: "draft", name: "notes.txt" });

        const listed = await storage.list();

        expect(listed.map((entry) => entry.id)).toStrictEqual([file.id]);
    });
});

describe("createUploadHandler maxFileSizeFor (per-request cap)", () => {
    const MiB = 1024 * 1024;

    const capped = (maxFileSizeFor: (context: UploadSizeContext) => number | undefined | Promise<number | undefined>, maxFileSize = 100 * MiB) =>
        createUploadHandler({ maxFileSize, maxFileSizeFor, silent: true, storage: createR2BindingUploadStorage(createFakeR2UploadBucket()) });

    const byType = (context: UploadSizeContext): number | undefined => {
        if (context.contentType?.startsWith("image/")) {
            return 1 * MiB;
        }

        return context.contentType?.startsWith("video/") ? 50 * MiB : undefined;
    };

    const create = async (handler: Handler, headers: Record<string, string>): Promise<Response> =>
        handler.fetch(new Request(ENDPOINT, { headers: { "Tus-Resumable": "1.0.0", ...headers }, method: "POST" }));

    it("caps an upload by the type its TUS metadata declares", async () => {
        expect.hasAssertions();

        const handler = capped(byType);

        const image = (size: number) => create(handler, { "Upload-Length": String(size), "Upload-Metadata": `filetype ${B64("image/png")}` });

        await expect(image(2 * MiB)).resolves.toHaveProperty("status", 413);
        await expect(image(MiB)).resolves.toHaveProperty("status", 201);
        await expect(create(handler, { "Upload-Length": String(20 * MiB), "Upload-Metadata": `filetype ${B64("video/mp4")}` })).resolves.toHaveProperty(
            "status",
            201,
        );
    });

    it("hands the decoded metadata and declared size to the callback", async () => {
        expect.hasAssertions();

        const seen: UploadSizeContext[] = [];
        const handler = capped((context) => {
            seen.push(context);

            return undefined;
        });

        await create(handler, { "Upload-Length": "42", "Upload-Metadata": `filename ${B64("résumé.pdf")},filetype ${B64("application/pdf")},flag` });

        expect(seen[0]?.metadata).toStrictEqual({ filename: "résumé.pdf", filetype: "application/pdf", flag: "" });
        expect(seen[0]?.contentType).toBe("application/pdf");
        expect(seen[0]?.declaredSize).toBe(42);
        expect(seen[0]?.method).toBe("POST");
    });

    it("never raises the cap past maxFileSize", async () => {
        expect.hasAssertions();

        const handler = capped(() => 10 * MiB, MiB);

        await expect(create(handler, { "Upload-Length": String(2 * MiB) })).resolves.toHaveProperty("status", 413);
    });

    it("refuses a create that declares no size once a cap applies", async () => {
        expect.hasAssertions();

        const handler = capped(() => MiB);

        await expect(create(handler, { "Upload-Defer-Length": "1" })).resolves.toHaveProperty("status", 413);
    });

    it("fails closed when the callback throws or answers something that is not a size", async () => {
        expect.hasAssertions();

        const throwing = capped(() => {
            throw new Error("lookup failed");
        });
        const nonsense = capped(() => Number.NaN);

        await expect(create(throwing, { "Upload-Length": "10" })).resolves.toHaveProperty("status", 403);
        await expect(create(nonsense, { "Upload-Length": "10" })).resolves.toHaveProperty("status", 403);
    });

    it("runs only on creates, after the authorize gate", async () => {
        expect.hasAssertions();

        const maxFileSizeFor = vi.fn<(context: UploadSizeContext) => number | undefined>(() => undefined);
        const handler = createUploadHandler({
            authorize: ({ request }) => request.headers.get("x-user") === "member",
            maxFileSizeFor,
            storage: createR2BindingUploadStorage(createFakeR2UploadBucket()),
        });

        await expect(create(handler, { "Upload-Length": "10" })).resolves.toHaveProperty("status", 403);
        expect(maxFileSizeFor).not.toHaveBeenCalled();

        const created = await create(handler, { "Upload-Length": "10", "x-user": "member" });
        const location = new URL(created.headers.get("location") ?? "", ENDPOINT).href;

        await handler.fetch(new Request(location, { headers: { "Tus-Resumable": "1.0.0", "x-user": "member" }, method: "HEAD" }));

        expect(maxFileSizeFor).toHaveBeenCalledTimes(1);
    });

    it("reads a chunked-REST create's X-File-Metadata", async () => {
        expect.hasAssertions();

        const handler = createUploadHandler({
            maxFileSizeFor: byType,
            protocol: "chunked-rest",
            silent: true,
            storage: createR2BindingUploadStorage(createFakeR2UploadBucket()),
        });

        const response = await handler.fetch(
            new Request(ENDPOINT, {
                headers: {
                    "content-type": "application/octet-stream",
                    "x-chunked-upload": "true",
                    "x-file-metadata": JSON.stringify({ filetype: "image/jpeg" }),
                    "x-total-size": String(2 * MiB),
                },
                method: "POST",
            }),
        );

        expect(response.status).toBe(413);
    });
});
