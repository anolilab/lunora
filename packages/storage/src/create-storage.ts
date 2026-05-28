import { buildSignedUrl } from "./signed-url.js";
import type { CirrusStorageOptions, ListOptions, R2ObjectBodyLike, R2ObjectLike, SignedUrlOptions, Storage, UploadOptions } from "./types.js";

export const createStorage = (options: CirrusStorageOptions): Storage => {
    if (!options.bucket) {
        throw new Error("@cirrus/storage: `bucket` is required");
    }

    const upload = async (key: string, body: ReadableStream | ArrayBuffer | Blob, uploadOpts: UploadOptions = {}): Promise<{ etag: string; key: string }> => {
        const object = await options.bucket.put(key, body, {
            httpMetadata: uploadOpts.contentType ? { contentType: uploadOpts.contentType } : undefined,
            customMetadata: uploadOpts.customMetadata,
        });

        return { key: object.key, etag: object.etag };
    };

    const download = async (key: string): Promise<R2ObjectBodyLike | null> => options.bucket.get(key);

    const deleteObject = async (key: string): Promise<void> => {
        await options.bucket.delete(key);
    };

    const list = async (prefix?: string, listOpts: ListOptions = {}): Promise<{ cursor?: string; objects: R2ObjectLike[] }> => {
        const result = await options.bucket.list({ prefix, limit: listOpts.limit, cursor: listOpts.cursor });

        return { objects: result.objects, cursor: result.cursor };
    };

    const getSignedUrl = async (key: string, signedOpts: SignedUrlOptions = {}): Promise<string> => {
        if (!options.publicBaseUrl) {
            throw new Error("@cirrus/storage: `publicBaseUrl` is required for getSignedUrl()");
        }

        if (!options.signingSecret) {
            throw new Error("@cirrus/storage: `signingSecret` is required for getSignedUrl()");
        }

        return buildSignedUrl({
            baseUrl: options.publicBaseUrl,
            secret: options.signingSecret,
            key,
            expiresInSeconds: signedOpts.expiresInSeconds,
            method: signedOpts.method,
        });
    };

    return { upload, download, delete: deleteObject, list, getSignedUrl };
};
