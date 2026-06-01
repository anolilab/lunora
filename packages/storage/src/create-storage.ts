import { buildSignedUrl } from "./signed-url.js";
import type { CirrusStorageOptions, ListOptions, R2ObjectBodyLike, R2ObjectLike, SignedUrlOptions, Storage, UploadOptions } from "./types.js";

/** R2's documented key-length ceiling. */
const MAX_KEY_LENGTH = 1024;

/** R2's documented per-page list ceiling. */
const MAX_LIST_LIMIT = 1000;

/** Default page size for `list()` — chosen to bound a default call's response shape. */
const DEFAULT_LIST_LIMIT = 100;

/** Trailing-slash trimmer for `publicBaseUrl`; hoisted to avoid per-call recompilation. */
const TRAILING_SLASHES_RE = /\/+$/;

/**
 * Reject keys that escape the bucket, contain a path-traversal segment, or
 * exceed R2's size ceiling. Used by every operation that takes a `key` —
 * upload/delete/get — so a malicious caller can't probe peer prefixes via
 * `..`, an empty string, or a NUL byte.
 *
 * Note: this does not enforce tenancy. Callers MUST also scope keys with a
 * per-tenant prefix (see {@link scopeKey}) to prevent IDOR across tenants.
 */
const validateKey = (key: string): void => {
    if (typeof key !== "string" || key.length === 0) {
        throw new Error("@cirrus/storage: key must be a non-empty string");
    }

    if (key.length > MAX_KEY_LENGTH) {
        throw new Error(`@cirrus/storage: key exceeds ${String(MAX_KEY_LENGTH)}-byte limit`);
    }

    if (key.includes("\0")) {
        throw new Error("@cirrus/storage: key contains NUL byte");
    }

    if (key.startsWith("/")) {
        throw new Error("@cirrus/storage: key must not start with `/`");
    }

    // Reject `..` as a path component (not just substring) so `a..b` is fine
    // but `a/../b`, `../b`, `b/..` are rejected.
    const segments = key.split("/");

    for (const segment of segments) {
        if (segment === "..") {
            throw new Error("@cirrus/storage: key contains a `..` path component");
        }
    }
};

/**
 * Compose a per-tenant key from a scope prefix and a caller-supplied key.
 * Both halves are validated — the prefix may not contain `..` or NUL either,
 * and the resulting key must stay under R2's length ceiling. Recommended for
 * any multi-tenant deployment so client-supplied keys can't address peer data.
 */
export const scopeKey = (prefix: string, key: string): string => {
    validateKey(prefix);
    validateKey(key);

    const trimmedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    const composed = `${trimmedPrefix}/${key}`;

    if (composed.length > MAX_KEY_LENGTH) {
        throw new Error(`@cirrus/storage: scoped key exceeds ${String(MAX_KEY_LENGTH)}-byte limit`);
    }

    return composed;
};

export const createStorage = (options: CirrusStorageOptions): Storage => {
    if (!options.bucket) {
        throw new Error("@cirrus/storage: `bucket` is required");
    }

    const upload = async (key: string, body: ReadableStream | ArrayBuffer | Blob, uploadOptions: UploadOptions = {}): Promise<{ etag: string; key: string }> => {
        validateKey(key);

        if (uploadOptions.allowedContentTypes && uploadOptions.contentType && !uploadOptions.allowedContentTypes.includes(uploadOptions.contentType)) {
            throw new Error(`@cirrus/storage: contentType "${uploadOptions.contentType}" not in allowedContentTypes`);
        }

        // `maxSize` is best-effort: enforced for byte sources we can size
        // synchronously (ArrayBuffer/Blob). ReadableStream byte counts aren't
        // known up front; callers streaming uploads must rely on the upstream
        // R2 multipart enforcement or pre-buffer.
        if (typeof uploadOptions.maxSize === "number") {
            const size = body instanceof ArrayBuffer ? body.byteLength : body instanceof Blob ? body.size : undefined;

            if (size !== undefined && size > uploadOptions.maxSize) {
                throw new Error(`@cirrus/storage: body exceeds maxSize (${String(size)} > ${String(uploadOptions.maxSize)})`);
            }
        }

        const object = await options.bucket.put(key, body, {
            customMetadata: uploadOptions.customMetadata,
            httpMetadata: uploadOptions.contentType ? { contentType: uploadOptions.contentType } : undefined,
        });

        return { etag: object.etag, key: object.key };
    };

    const download = async (key: string): Promise<R2ObjectBodyLike | null> => {
        validateKey(key);

        return options.bucket.get(key);
    };

    const deleteObject = async (key: string): Promise<void> => {
        validateKey(key);
        await options.bucket.delete(key);
    };

    const list = async (prefix?: string, listOptions: ListOptions = {}): Promise<{ cursor?: string; objects: R2ObjectLike[] }> => {
        // `prefix` is intentionally permissive: it's read-only and a malformed
        // value just produces an empty result. We still reject NUL bytes since
        // the R2 binding silently truncates at the NUL on some runtimes.
        if (prefix !== undefined && prefix.includes("\0")) {
            throw new Error("@cirrus/storage: prefix contains NUL byte");
        }

        const requested = listOptions.limit ?? DEFAULT_LIST_LIMIT;
        const limit = Math.min(Math.max(1, Math.floor(requested)), MAX_LIST_LIMIT);
        const result = await options.bucket.list({ cursor: listOptions.cursor, delimiter: listOptions.delimiter, limit, prefix });

        return { cursor: result.cursor, objects: result.objects };
    };

    const getUrl = (key: string): string => {
        if (!options.publicBaseUrl) {
            throw new Error("@cirrus/storage: `publicBaseUrl` is required for getUrl()");
        }

        validateKey(key);

        // Encode each path segment the same way buildSignedUrl does so getUrl
        // and getSignedUrl agree on the key representation — validateKey permits
        // URL-significant chars (`?`, `#`, space) that would otherwise corrupt
        // the public URL.
        const safeKey = key
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/");

        return `${options.publicBaseUrl.replace(TRAILING_SLASHES_RE, "")}/${safeKey}`;
    };

    const getSignedUrl = async (key: string, signedOptions: SignedUrlOptions = {}): Promise<string> => {
        if (!options.publicBaseUrl) {
            throw new Error("@cirrus/storage: `publicBaseUrl` is required for getSignedUrl()");
        }

        if (!options.signingSecret) {
            throw new Error("@cirrus/storage: `signingSecret` is required for getSignedUrl()");
        }

        validateKey(key);

        return buildSignedUrl({
            baseUrl: options.publicBaseUrl,
            expiresInSeconds: signedOptions.expiresInSeconds,
            key,
            method: signedOptions.method,
            secret: options.signingSecret,
        });
    };

    return { delete: deleteObject, download, getSignedUrl, getUrl, list, upload };
};
