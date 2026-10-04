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
        await expect(response.json()).resolves.toMatchObject({ error: { code: "FileConflict" } });
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
