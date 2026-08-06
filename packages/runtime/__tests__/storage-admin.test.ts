import { describe, expect, it, vi } from "vitest";

import type {
    ExecutionContextLike,
    StorageDeleteFn as StorageDeleteFunction,
    StorageListFn as StorageListFunction,
    StorageSignedUrlFn as StorageSignedUrlFunction,
    StorageUploadFn as StorageUploadFunction,
} from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("not used", { status: 200 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

const ADMIN_TOKEN = "admin-bear";

const PAGE = { cursor: "c1", objects: [{ etag: "e1", key: "a.png", size: 10 }] };

describe("createWorker — storage admin endpoint", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageList: async () => PAGE });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/storage", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("reports STORAGE_NOT_CONFIGURED when no lister is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("STORAGE_NOT_CONFIGURED");
    });

    it("forwards prefix / cursor / limit / bucket to the lister and returns the page", async () => {
        expect.assertions(3);

        const storageList = vi.fn<StorageListFunction>(async () => PAGE);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageList });

        const response = await worker.fetch(
            // eslint-disable-next-line no-secrets/no-secrets -- example admin URL fixture, not a secret
            new Request("https://app.example/_lunora/admin/storage?prefix=avatars/&cursor=z&limit=25&bucket=media", {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "GET",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(PAGE);
        expect(storageList).toHaveBeenCalledWith("avatars/", { bucket: "media", cursor: "z", limit: 25 });
    });

    it("lists the configured buckets for the file-browser picker", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageBuckets: ["default", "media"] });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage/buckets", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ buckets: ["default", "media"] });
    });

    it("returns an empty bucket list (not an error) when none are configured", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage/buckets", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ buckets: [] });
    });

    it("rejects an unsupported method (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageList: async () => PAGE });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "PATCH" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });
});

describe("createWorker — storage admin delete", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageDelete: async () => undefined });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/storage?key=a.png", { method: "DELETE" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("reports STORAGE_DELETE_NOT_CONFIGURED when no deleter is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage?key=a.png", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "DELETE" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("STORAGE_DELETE_NOT_CONFIGURED");
    });

    it("requires a key query parameter (400)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageDelete: async () => undefined });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "DELETE" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);
    });

    it("forwards the key to the deleter and confirms", async () => {
        expect.assertions(3);

        const storageDelete = vi.fn<StorageDeleteFunction>(async () => undefined);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageDelete });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage?key=avatars/a.png", {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "DELETE",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ deleted: true, key: "avatars/a.png" });
        expect(storageDelete).toHaveBeenCalledWith("avatars/a.png", { bucket: undefined });
    });
});

describe("createWorker — storage admin upload", () => {
    it("reports STORAGE_UPLOAD_NOT_CONFIGURED when no uploader is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage?key=a.txt", {
                body: "hi",
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "PUT",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("STORAGE_UPLOAD_NOT_CONFIGURED");
    });

    it("forwards key, bytes, and content-type to the uploader", async () => {
        expect.assertions(4);

        const storageUpload = vi.fn<StorageUploadFunction>(async (key: string) => {
            return { etag: "e9", key };
        });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageUpload });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage?key=docs/readme.txt", {
                body: "hello",
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "text/plain" },
                method: "PUT",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ etag: "e9", key: "docs/readme.txt" });

        const [key, body, uploadOptions] = storageUpload.mock.calls[0] as unknown as [string, ArrayBuffer, { contentType?: string }];

        expect(key).toBe("docs/readme.txt");
        expect({ bytes: new TextDecoder().decode(body), contentType: uploadOptions.contentType }).toEqual({ bytes: "hello", contentType: "text/plain" });
    });

    it("rejects an over-budget upload with 413 before invoking the uploader", async () => {
        expect.assertions(2);

        const storageUpload = vi.fn<StorageUploadFunction>(async (key: string) => {
            return { key };
        });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageUpload });

        // One byte past the 1 MiB MAX_BODY_BYTES cap.
        const oversized = "x".repeat(1_048_577);
        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage?key=docs/big.bin", {
                body: oversized,
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/octet-stream" },
                method: "PUT",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(413);
        expect(storageUpload).not.toHaveBeenCalled();
    });

    it("rejects a mismatched expectedSize with 400 before invoking the uploader", async () => {
        expect.assertions(3);

        const storageUpload = vi.fn<StorageUploadFunction>(async (key: string) => {
            return { etag: "e9", key };
        });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageUpload });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage?key=docs/readme.txt&expectedSize=999", {
                body: "hello",
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "text/plain" },
                method: "PUT",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("STORAGE_CHECKSUM_MISMATCH");
        expect(storageUpload).not.toHaveBeenCalled();
    });

    it("rejects a mismatched expectedSha256 with 400 before invoking the uploader", async () => {
        expect.assertions(3);

        const storageUpload = vi.fn<StorageUploadFunction>(async (key: string) => {
            return { etag: "e9", key };
        });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageUpload });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage?key=docs/readme.txt&expectedSha256=deadbeef", {
                body: "hello",
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "text/plain" },
                method: "PUT",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("STORAGE_CHECKSUM_MISMATCH");
        expect(storageUpload).not.toHaveBeenCalled();
    });

    it("accepts a matching expectedSize + expectedSha256, writes the blob, and echoes the hash", async () => {
        expect.assertions(4);

        const storageUpload = vi.fn<StorageUploadFunction>(async (key: string) => {
            return { etag: "e9", key };
        });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageUpload });

        // sha256("hello"), base16 lowercase — the base64-encoded form the
        // verification path must reject if the caller passes it (case/blobs).
        const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        const response = await worker.fetch(
            new Request(`https://app.example/_lunora/admin/storage?key=docs/readme.txt&expectedSize=5&expectedSha256=${sha256}`, {
                body: "hello",
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "text/plain" },
                method: "PUT",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ etag: "e9", key: "docs/readme.txt", sha256 });
        expect(storageUpload).toHaveBeenCalledTimes(1);

        const [, storedBody] = storageUpload.mock.calls[0] as unknown as [string, ArrayBuffer];

        expect(new TextDecoder().decode(storedBody)).toBe("hello");
    });

    it("accepts a case-variant expectedSha256 (comparison is case-insensitive)", async () => {
        expect.assertions(1);

        const storageUpload = vi.fn<StorageUploadFunction>(async (key: string) => {
            return { etag: "e9", key };
        });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageUpload });

        const response = await worker.fetch(
            new Request(
                // eslint-disable-next-line no-secrets/no-secrets -- example admin URL fixture, not a secret
                "https://app.example/_lunora/admin/storage?key=docs/readme.txt&expectedSize=5&expectedSha256=2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824",
                {
                    body: "hello",
                    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "text/plain" },
                    method: "PUT",
                },
            ),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
    });
});

describe("createWorker — storage admin signed URL", () => {
    it("reports STORAGE_URL_NOT_CONFIGURED when no signer is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage/url?key=a.png", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("STORAGE_URL_NOT_CONFIGURED");
    });

    it("returns the signed URL for the key", async () => {
        expect.assertions(3);

        const storageSignedUrl = vi.fn<StorageSignedUrlFunction>(async (key: string) => `https://cdn.example/${key}?sig=abc`);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageSignedUrl });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage/url?key=avatars/a.png", {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "GET",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ key: "avatars/a.png", url: "https://cdn.example/avatars/a.png?sig=abc" });
        // No `expiresIn` query → the host gets `undefined` (its own default applies).
        expect(storageSignedUrl).toHaveBeenCalledWith("avatars/a.png", { bucket: undefined, expiresInSeconds: undefined });
    });

    it("forwards a positive expiresIn as the share-link lifetime", async () => {
        expect.assertions(2);

        const storageSignedUrl = vi.fn<StorageSignedUrlFunction>(async (key: string) => `https://cdn.example/${key}?sig=abc`);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageSignedUrl });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage/url?key=a.png&expiresIn=900", {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "GET",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(storageSignedUrl).toHaveBeenCalledWith("a.png", { bucket: undefined, expiresInSeconds: 900 });
    });

    it("clamps an over-max expiresIn to the 7-day ceiling", async () => {
        expect.assertions(2);

        const storageSignedUrl = vi.fn<StorageSignedUrlFunction>(async (key: string) => `https://cdn.example/${key}?sig=abc`);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageSignedUrl });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/storage/url?key=a.png&expiresIn=999999999", {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "GET",
            }),
            {},
            fakeContext,
        );

        // The worker clamps to 7 days (604800s) instead of letting the host throw a 500.
        expect(response.status).toBe(200);
        expect(storageSignedUrl).toHaveBeenCalledWith("a.png", { bucket: undefined, expiresInSeconds: 604_800 });
    });
});
