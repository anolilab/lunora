/**
 * A chunked-REST `PUT` names its own file, and upstream's `PUT` replaces
 * whatever is stored under that name (visulima/visulima#919). The route makes
 * it create-only, over both R2 providers.
 */
import { putFile } from "@visulima/storage-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createR2BindingUploadStorage } from "../src/r2-binding-upload-storage";
import { createR2UploadStorage } from "../src/r2-s3-upload-storage";
import type { UploadStorage } from "../src/upload-handler";
import { createUploadHandler } from "../src/upload-handler";
import { createFakeR2S3 } from "./fake-r2-s3";
import { createFakeR2UploadBucket } from "./fake-r2-upload-bucket";
import { sameBytes } from "./upload-pattern";

const ENDPOINT = "https://test.local/upload";
const SECRET = new TextEncoder().encode("SECRET PAYROLL");

/** A bucket behind one of the two R2 providers: seed objects into it, read them back. */
interface Bucket {
    read: (key: string) => Uint8Array | undefined;
    seed: (key: string, bytes: Uint8Array<ArrayBuffer>) => Promise<void>;
    storage: () => UploadStorage;
}

const bindingBucket = (): Bucket => {
    const bucket = createFakeR2UploadBucket();

    return {
        read: (key) => bucket.objects.get(key)?.bytes,
        seed: async (key, bytes) => {
            await bucket.put(key, bytes);
        },
        storage: () => createR2BindingUploadStorage(bucket),
    };
};

const s3Bucket = (): Bucket => {
    const s3 = createFakeR2S3("uploads");

    vi.stubGlobal("fetch", s3.fetch);

    return {
        read: (key) => s3.object(key),
        seed: async (key, bytes) => {
            await s3.fetch(new Request(`https://acct.r2.cloudflarestorage.com/uploads/${key}`, { body: bytes, method: "PUT" }));
        },
        storage: () => createR2UploadStorage({ accessKeyId: "id", accountId: "acct", bucket: "uploads", path: "/upload", secretAccessKey: "secret" }),
    };
};

const put = (name: string, body: string): Request =>
    new Request(`${ENDPOINT}/${name}`, { body, headers: { "content-length": String(body.length), "content-type": "text/plain" }, method: "PUT" });

const text = (bytes: Uint8Array | undefined): string | undefined => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

describe.each([
    ["createR2BindingUploadStorage", bindingBucket],
    ["createR2UploadStorage", s3Bucket],
])("a chunked-REST PUT over %s is create-only", (_, makeBucket) => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const routeOver = (bucket: Bucket, authorize: () => boolean = () => true) =>
        createUploadHandler({ authorize, protocol: "chunked-rest", storage: bucket.storage() });

    it("stores a file under a new name (201)", async () => {
        expect.hasAssertions();

        const bucket = makeBucket();
        const response = await routeOver(bucket).fetch(put("report-v2.txt", "first"));

        expect(response.status).toBe(201);
        expect(text(bucket.read("report-v2"))).toBe("first");
    });

    it("refuses a second PUT to the same name (409) and keeps the first file", async () => {
        expect.hasAssertions();

        const bucket = makeBucket();
        const route = routeOver(bucket);

        await expect(route.fetch(put("report-v2.txt", "first"))).resolves.toHaveProperty("status", 201);
        await expect(route.fetch(put("report-v2.txt", "second"))).resolves.toHaveProperty("status", 409);
        expect(text(bucket.read("report-v2"))).toBe("first");
    });

    it("refuses a PUT onto an object the route never created (409) and leaves it as it was", async () => {
        expect.hasAssertions();

        const bucket = makeBucket();

        await bucket.seed("payroll-2026", SECRET);

        const response = await routeOver(bucket).fetch(put("payroll-2026.txt", "evil"));

        expect(response.status).toBe(409);
        expect(sameBytes(bucket.read("payroll-2026"), SECRET)).toBe(true);
    });

    it("answers a refused caller's PUT onto a taken name with the authorize refusal, not 409", async () => {
        expect.hasAssertions();

        const bucket = makeBucket();

        await bucket.seed("payroll-2026", SECRET);

        await expect(routeOver(bucket, () => false).fetch(put("payroll-2026.txt", "evil"))).resolves.toHaveProperty("status", 403);
        expect(sameBytes(bucket.read("payroll-2026"), SECRET)).toBe(true);
    });

    it("still lets the client's putFile store a file under a new name", async () => {
        expect.hasAssertions();

        const bucket = makeBucket();
        const route = routeOver(bucket);
        const storageFetch = globalThis.fetch;

        // `putFile` sends through XMLHttpRequest, which Node lacks: route it at the handler.
        class RoutedXhr {
            public readonly upload = { addEventListener: (): void => undefined };

            public status = 0;

            public statusText = "";

            public responseText = "";

            private readonly listeners = new Map<string, () => void>();

            private method = "GET";

            private readonly requestHeaders: Record<string, string> = {};

            private response: Response | undefined;

            private url = "";

            public addEventListener(type: string, listener: () => void): void {
                this.listeners.set(type, listener);
            }

            public getResponseHeader(name: string): string | null {
                return this.response?.headers.get(name) ?? null;
            }

            public open(method: string, url: string): void {
                this.method = method;
                this.url = url;
            }

            public send(body: Blob): void {
                this.deliver(body).catch(() => this.listeners.get("error")?.());
            }

            public setRequestHeader(name: string, value: string): void {
                this.requestHeaders[name] = value;
            }

            private async deliver(body: Blob): Promise<void> {
                const bytes = new Uint8Array(await body.arrayBuffer());

                this.response = await route.fetch(
                    new Request(this.url, {
                        body: bytes,
                        headers: { ...this.requestHeaders, "content-length": String(bytes.byteLength) },
                        method: this.method,
                    }),
                );
                this.status = this.response.status;
                this.responseText = await this.response.text();
                this.listeners.get("load")?.();
            }
        }

        vi.stubGlobal("XMLHttpRequest", RoutedXhr);
        // The S3 fake stays installed for the provider's own requests.
        vi.stubGlobal("fetch", storageFetch);

        await expect(putFile(`${ENDPOINT}/notes.txt`, new Blob(["via putFile"]))).resolves.toMatchObject({
            location: expect.stringContaining("/upload/notes"),
        });
        expect(text(bucket.read("notes"))).toBe("via putFile");
        await expect(putFile(`${ENDPOINT}/notes.txt`, new Blob(["again"]))).rejects.toMatchObject({ status: 409 });
        expect(text(bucket.read("notes"))).toBe("via putFile");
    });
});

describe("a chunked-REST PUT over createR2BindingUploadStorage, raced", () => {
    it("lets exactly one of two concurrent PUTs to one new name through; the other is a 409", async () => {
        expect.hasAssertions();

        const bucket = bindingBucket();
        const route = createUploadHandler({ protocol: "chunked-rest", silent: true, storage: bucket.storage() });
        const responses = await Promise.all([route.fetch(put("race.txt", "one")), route.fetch(put("race.txt", "two"))]);
        const statuses = responses.map((response) => response.status).toSorted((a, b) => a - b);

        expect(statuses).toStrictEqual([201, 409]);

        const winner = responses[0]?.status === 201 ? "one" : "two";

        expect(text(bucket.read("race"))).toBe(winner);
    });
});

describe("a chunked-REST PUT's name check", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // Fail closed: the state lookup is the route's (409), the object lookup upstream's, which passes the 403 on.
    it.each([
        ["the object's HEAD", "/uploads/victim", 403],
        ["the upload state's HEAD", "/uploads/victim.META", 409],
    ])("over createR2UploadStorage refuses a PUT when %s fails (403), so nothing is replaced", async (_, failing, status) => {
        expect.hasAssertions();

        const s3 = createFakeR2S3("uploads");

        await s3.fetch(new Request("https://acct.r2.cloudflarestorage.com/uploads/victim", { body: SECRET, method: "PUT" }));
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const request = input instanceof Request ? input : new Request(input, init);

            if (request.method === "HEAD" && new URL(request.url).pathname === failing) {
                // Not a 5xx, which aws4fetch retries with backoff for up to a minute first.
                return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
            }

            return s3.fetch(request);
        });

        const route = createUploadHandler({
            protocol: "chunked-rest",
            silent: true,
            storage: createR2UploadStorage({ accessKeyId: "id", accountId: "acct", bucket: "uploads", path: "/upload", secretAccessKey: "secret" }),
        });

        await expect(route.fetch(put("victim.txt", "evil"))).resolves.toHaveProperty("status", status);

        expect(sameBytes(s3.object("victim"), SECRET)).toBe(true);
    });

    it.each([
        ["no Content-Length worth storing", new Request(`${ENDPOINT}/payroll-2026.txt`, { body: "", headers: { "content-length": "0" }, method: "PUT" }), 400],
        ["a size the per-upload cap refuses", put("payroll-2026.txt", "too large for the cap"), 413],
    ])("keeps upstream's or the cap's own answer for a PUT onto a taken name with %s, not 409", async (_, request, status) => {
        expect.hasAssertions();

        const bucket = bindingBucket();

        await bucket.seed("payroll-2026", SECRET);

        const route = createUploadHandler({ maxFileSizeFor: () => 4, protocol: "chunked-rest", silent: true, storage: bucket.storage() });

        await expect(route.fetch(request)).resolves.toHaveProperty("status", status);
        expect(sameBytes(bucket.read("payroll-2026"), SECRET)).toBe(true);
    });
});

describe("a create-only PUT over createR2BindingUploadStorage that loses its name while it streams", () => {
    /**
     * `length` bytes in four pieces. Once the upload has started reading them
     * (the first piece is pulled when the request is built, before any check),
     * another writer stores `key`.
     */
    const racedBody = (bucket: ReturnType<typeof createFakeR2UploadBucket>, key: string, length: number): ReadableStream<Uint8Array> => {
        let sent = 0;

        return new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (sent > 0 && !bucket.objects.has(key)) {
                    await bucket.put(key, SECRET);
                }

                const size = Math.min(Math.ceil(length / 4), length - sent);

                controller.enqueue(new Uint8Array(size).fill(7));
                sent += size;

                if (sent >= length) {
                    controller.close();
                }
            },
        });
    };

    it.each([
        ["a single put (under 5 MiB)", 1024],
        ["a multipart upload (over 5 MiB)", 6 * 1024 * 1024],
    ])("answers 409 for %s, keeps the other writer's object, and leaves no upload, segment or state behind", async (_, length) => {
        expect.hasAssertions();

        const bucket = createFakeR2UploadBucket();
        const route = createUploadHandler({ protocol: "chunked-rest", silent: true, storage: createR2BindingUploadStorage(bucket) });
        const response = await route.fetch(
            new Request(`${ENDPOINT}/late.bin`, {
                body: racedBody(bucket, "late", length),
                duplex: "half",
                headers: { "content-length": String(length), "content-type": "application/octet-stream" },
                method: "PUT",
            } as RequestInit),
        );

        expect(response.status).toBe(409);
        expect(sameBytes(bucket.objects.get("late")?.bytes, SECRET)).toBe(true);
        expect([...bucket.openUploads.keys()]).toStrictEqual([]);
        expect([...bucket.objects.keys()]).toStrictEqual(["late"]);
    });
});
