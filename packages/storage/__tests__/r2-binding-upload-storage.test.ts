/**
 * The binding-backed upload provider, driven through `createUploadHandler` over
 * an in-memory R2 binding (see `fake-r2-upload-bucket.ts`).
 */
import { createTusAdapter, UploadControl } from "@visulima/storage-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { R2UploadBucket } from "../src/r2-binding-upload-storage";
import { createR2BindingUploadStorage, R2_PART_SIZE } from "../src/r2-binding-upload-storage";
import { createUploadHandler } from "../src/upload-handler";
import { createFakeR2UploadBucket } from "./fake-r2-upload-bucket";
import { pattern } from "./upload-pattern";

const ENDPOINT = "https://test.local/upload";
const STATE_PREFIX = "_lunora/uploads/";
const B64 = (value: string): string => Buffer.from(value).toString("base64");

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

/** The upload's state object, as the provider stored it. */
const readState = (
    bucket: ReturnType<typeof createFakeR2UploadBucket>,
    location: string,
): { file: { bytesWritten: number }; upload: Record<string, unknown> } => {
    const object = bucket.objects.get(`${STATE_PREFIX}${location.split("/").pop() ?? ""}.json`);

    return JSON.parse(new TextDecoder().decode(object?.bytes)) as { file: { bytesWritten: number }; upload: Record<string, unknown> };
};

/** A body that hands over `first`, then waits for `release()` before sending `rest`. */
const pausedBody = (first: Uint8Array, rest: Uint8Array) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (pulled === 0) {
                pulled += 1;
                controller.enqueue(first);

                return;
            }

            await gate;
            controller.enqueue(rest);
            controller.close();
        },
    });

    return {
        body,
        pulled: () => pulled,
        release: () => {
            release();
        },
    };
};

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

    it("refuses a create whose declared size is negative, missing or not an integer", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const storage = createR2BindingUploadStorage(bucket);

        // The provider is the last line: whatever reaches it without a usable
        // size is refused, so no byte limit can be skipped.
        for (const size of [-1, 1.5, Number.NaN, undefined, "", "-1"]) {
            // eslint-disable-next-line no-await-in-loop -- one create per case
            await expect(storage.create({ metadata: { name: "a.bin" }, size })).rejects.toMatchObject({ UploadErrorCode: "InvalidFileSize" });
        }

        expect([...bucket.objects.keys()]).toStrictEqual([]);
    });

    it("never lets Upload-Length: -1 store more than the cap (regression)", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const handler = createUploadHandler({
            maxFileSize: 1024 * 1024,
            maxFileSizeFor: () => 10,
            silent: true,
            storage: createR2BindingUploadStorage(bucket),
        });
        const created = await handler.fetch(
            new Request(ENDPOINT, {
                headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "-1", "Upload-Metadata": `filename ${B64("a.bin")}` },
                method: "POST",
            }),
        );

        expect(created.status).toBe(413);
        expect([...bucket.objects.keys()]).toStrictEqual([]);
    });

    it("keeps a finished file when expiration sweeps its upload state (regression)", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const handler = createUploadHandler({ silent: true, storage: createR2BindingUploadStorage(bucket, { expiration: { maxAge: 1 } }) });
        const driver = tus(handler);
        const location = await driver.create(5, "a.txt");

        await sendChunks(driver, location, pattern(5), 5);
        await new Promise((resolve) => {
            setTimeout(resolve, 10);
        });

        // The expired state answers "gone", and is dropped; the file stays.
        const head = await driver.head(location);

        expect([404, 410]).toContain(head.status);

        await vi.waitFor(() => {
            expect(stateKeys(bucket)).toStrictEqual([]);
        });

        expect(sameBytes(storedObject(bucket, location)?.bytes, pattern(5))).toBe(true);
    });

    it("stops a writer whose lease was taken over: it neither stores parts nor finishes (regression)", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const bytes = pattern(R2_PART_SIZE + 1000);
        const location = await driver.create(bytes.byteLength);
        const paused = pausedBody(bytes.slice(0, 1000), bytes.slice(1000));
        const inFlight = driver.patch(location, 0, paused.body);

        await vi.waitFor(() => {
            expect(paused.pulled()).toBe(1);
            expect(readState(bucket, location).upload.lock).toBeDefined();
        });

        // Another request took the upload over after this one's lease lapsed.
        const id = location.split("/").pop() ?? "";
        const state = readState(bucket, location);

        state.upload.lock = { expiresAt: Date.now() + 60_000, token: "someone-else" };
        await bucket.put(`${STATE_PREFIX}${id}.json`, JSON.stringify(state));

        paused.release();

        await expect(inFlight).resolves.toHaveProperty("status", 409);
        expect(storedObject(bucket, location)).toBeUndefined();
        expect(bucket.openUploads.size).toBe(0);
    });

    it("records progress after every part, so a killed request loses at most the part in flight", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const bytes = pattern(2 * R2_PART_SIZE + 10);
        const location = await driver.create(bytes.byteLength);
        const cut = R2_PART_SIZE + 100;
        const paused = pausedBody(bytes.slice(0, cut), bytes.slice(cut));
        const inFlight = driver.patch(location, 0, paused.body);

        // Mid-request, with one part stored and the rest held up.
        await vi.waitFor(() => {
            expect(readState(bucket, location).file.bytesWritten).toBe(R2_PART_SIZE);
        });

        paused.release();

        await expect(inFlight).resolves.toHaveProperty("status", 200);
        expect(sameBytes(storedObject(bucket, location)?.bytes, bytes)).toBe(true);
    });

    it("joins waiting segments once there are too many, so tiny chunks cannot pile them up", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const driver = tus(handlerOver(bucket));
        const bytes = pattern(30_000);
        const location = await driver.create(bytes.byteLength + 1);

        await sendChunks(driver, location, bytes, 1000);

        expect(stateKeys(bucket).length).toBeLessThanOrEqual(1 + 8);

        await sendChunks(driver, location, pattern(bytes.byteLength + 1), 1, bytes.byteLength);

        expect(sameBytes(storedObject(bucket, location)?.bytes, pattern(bytes.byteLength + 1))).toBe(true);
    });

    it("refuses an object name under the upload state prefix", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const storage = createR2BindingUploadStorage(bucket, { filename: () => `${STATE_PREFIX}victim.json` });

        await expect(storage.create({ metadata: { name: "a.bin" }, size: 4 })).rejects.toMatchObject({ UploadErrorCode: "InvalidFileName" });
        expect([...bucket.objects.keys()]).toStrictEqual([]);
    });

    it("lets one of two racing creates for an id write the state, and both answer it", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const storage = createR2BindingUploadStorage(bucket);
        const init = { id: "same-upload-id", metadata: { name: "a.bin" }, size: 10 };
        const [first, second] = await Promise.all([storage.create(init), storage.create(init)]);

        expect(first.id).toBe("same-upload-id");
        expect(second.id).toBe("same-upload-id");
        expect(stateKeys(bucket)).toStrictEqual([`${STATE_PREFIX}same-upload-id.json`]);
    });

    it("keeps a failed part upload from being stored as an oversized segment; the next PATCH resumes at the last part", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        let uploads = 0;
        // The second part upload fails, as an R2 call can.
        const flaky: R2UploadBucket = {
            ...bucket,
            resumeMultipartUpload: (key, uploadId) => {
                const upload = bucket.resumeMultipartUpload(key, uploadId);

                return {
                    ...upload,
                    abort: upload.abort,
                    complete: upload.complete,
                    key: upload.key,
                    uploadId: upload.uploadId,
                    uploadPart: async (partNumber, value) => {
                        uploads += 1;

                        if (uploads === 2) {
                            throw new Error("R2 is unavailable");
                        }

                        return upload.uploadPart(partNumber, value);
                    },
                };
            },
        };
        const driver = tus(handlerOver(flaky));
        const bytes = pattern(2 * R2_PART_SIZE + 100);
        const location = await driver.create(bytes.byteLength);
        const failed = await driver.patch(location, 0, bytes);

        expect(failed.status).toBeGreaterThanOrEqual(500);

        // The state stopped at the part it recorded, unlocked, with nothing waiting.
        const state = readState(bucket, location);

        expect(state.file.bytesWritten).toBe(R2_PART_SIZE);
        expect(state.upload.lock).toBeUndefined();
        expect(state.upload.segments).toStrictEqual([]);

        for (const key of stateKeys(bucket)) {
            expect(bucket.objects.get(key)?.bytes.byteLength ?? 0).toBeLessThan(R2_PART_SIZE);
        }

        await expect(offsetOf(driver.head(location))).resolves.toBe(String(R2_PART_SIZE));

        await sendChunks(driver, location, bytes, 2 * R2_PART_SIZE, R2_PART_SIZE);

        expect(sameBytes(storedObject(bucket, location)?.bytes, bytes)).toBe(true);
        expect(bucket.partSizes).toStrictEqual([[R2_PART_SIZE, R2_PART_SIZE, 100]]);
    });

    it("buffers a small finished file in get(), streams any size from getStream(), and refuses a large get() (413)", async () => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const storage = createR2BindingUploadStorage(bucket);
        const small = await storage.create({ id: "small-file", metadata: { name: "s.bin" }, size: 4 });

        await storage.write({ body: new Blob([pattern(4)]).stream() as never, contentLength: 4, id: small.id, start: 0 });

        const read = await storage.get({ id: small.id });

        expect(sameBytes(read.content, pattern(4))).toBe(true);

        // A finished upload of 33 MiB: stored directly, its state marked complete.
        const size = 33 * 1024 * 1024;
        const large = await storage.create({ id: "large-file", metadata: { name: "l.bin" }, size });
        const stateKey = `${STATE_PREFIX}${large.id}.json`;
        const state = JSON.parse(new TextDecoder().decode(bucket.objects.get(stateKey)?.bytes)) as { file: Record<string, unknown> };

        state.file.bytesWritten = size;
        state.file.status = "completed";
        await bucket.put(stateKey, JSON.stringify(state));
        await bucket.put(large.name, new Uint8Array(size).fill(9));

        await expect(storage.get({ id: large.id })).rejects.toMatchObject({ UploadErrorCode: "RequestEntityTooLarge" });

        const { size: streamedSize, stream } = await storage.getStream({ id: large.id });
        let received = 0;

        for await (const chunk of stream) {
            received += (chunk as Uint8Array).byteLength;
        }

        expect(streamedSize).toBe(size);
        expect(received).toBe(size);
    });
});
