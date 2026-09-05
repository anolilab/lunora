import { LunoraError } from "@lunora/errors";

import { toBase64 } from "../../../shared/base64";
import { hasControlChar } from "../../../shared/hmac-url";
import { toHex, trimTrailingSlashes } from "./internal";
import { buildPresignedUrl } from "./presigned-url";
import { buildSignedUrl } from "./signed-url";
import type {
    ListOptions,
    LunoraStorageOptions,
    ObjectMetadata,
    PresignedUrlOptions,
    R2MultipartUploadLike,
    R2ObjectBodyLike,
    R2ObjectLike,
    R2RangeLike,
    SignedUrlOptions,
    Storage,
    UploadOptions,
} from "./types";

/** Accepted upload body shapes (bytes, blob, or a byte stream). */
type UploadBody = ReadableStream | ArrayBuffer | Blob;

/** R2's documented key-length ceiling. */
const MAX_KEY_LENGTH = 1024;

/** R2's documented per-page list ceiling. */
const MAX_LIST_LIMIT = 1000;

/** Default page size for `list()` — chosen to bound a default call's response shape. */
const DEFAULT_LIST_LIMIT = 100;

/**
 * Ceiling on a `maxSize` used with a STREAMED body, which has to be buffered
 * whole — see {@link collectStreamWithinMaxSize} for why it cannot stay a
 * stream.
 *
 * A Worker isolate has roughly 128 MB for everything and shares it across every
 * concurrent request, so the cap is not a per-request budget: N in-flight
 * uploads each hold up to `maxSize`, and a cap in the tens of megabytes OOMs the
 * isolate two or three uploads deep with every single one inside its documented
 * limit. 16 MiB leaves room for a handful of concurrent uploads; anything larger
 * belongs on `createMultipartUpload`/`createUploadHandler`, neither of which
 * holds the whole object.
 */
const MAX_BUFFERED_STREAM_SIZE = 16 * 1024 * 1024;

/**
 * Surface R2's SHA-256 checksum as `sha256` (hex) and `sha256Base64` (base64)
 * fields on the object metadata.
 *
 * A real `R2Object`/`R2ObjectBody` is a workerd host object: its properties are
 * `readonly`, it is **non-extensible**, and accessors like `body` plus methods
 * like `arrayBuffer()`/`text()` are native — they throw "Illegal invocation"
 * unless invoked with the original host object as `this`. That rules out three
 * naive approaches: a `{ ...object }` spread drops the prototype methods; an
 * in-place `object.sha256 = …` throws `TypeError: object is not extensible` in
 * strict mode (ESM is always strict); and an `Object.create(object)` wrapper
 * rebinds `this` for the native accessors and breaks them.
 *
 * So we wrap the object in a `Proxy` that answers `sha256`/`sha256Base64` itself
 * and forwards every other access to the underlying host object with the host
 * object as the receiver (so native getters keep their `this`), binding
 * function-valued properties to the target (so native methods keep their
 * `this`). A no-op pass-through when R2 carries no checksum, so the fields stay
 * absent rather than `undefined`-valued and we avoid an allocation on the common
 * path.
 */
const withSha256 = <T extends R2ObjectLike>(object: T): T => {
    const raw = object.checksums?.sha256;

    if (raw === undefined) {
        return object;
    }

    const sha256 = toHex(raw);
    const sha256Base64 = toBase64(new Uint8Array(raw));

    return new Proxy(object, {
        get(target, property) {
            if (property === "sha256") {
                return sha256;
            }

            if (property === "sha256Base64") {
                return sha256Base64;
            }

            // Forward with `target` as the receiver so native accessors (e.g.
            // R2ObjectBody's `body` getter) run against the real host object.
            const value = Reflect.get(target, property, target) as unknown;

            // Bind function-valued properties (arrayBuffer/text/bytes/…) to the
            // target so native methods aren't invoked with the Proxy as `this`.
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
        has(target, property) {
            return property === "sha256" || property === "sha256Base64" || Reflect.has(target, property);
        },
    });
};

/**
 * Project an {@link R2ObjectLike} (from `head()` or a ranged `get()`) into the
 * flat, body-free {@link ObjectMetadata} shape. `sha256` is derived from R2's
 * checksum when present; `uploaded` is normalised from R2's `Date` to epoch ms.
 */
const toMetadata = (object: R2ObjectLike): ObjectMetadata => {
    const raw = object.checksums?.sha256;

    return {
        contentType: object.httpMetadata?.contentType,
        customMetadata: object.customMetadata,
        key: object.key,
        sha256: raw === undefined ? undefined : toHex(raw),
        size: object.size,
        uploaded: object.uploaded === undefined ? undefined : object.uploaded.getTime(),
    };
};

/**
 * Project an {@link R2ObjectLike} `list()` entry into a plain object carrying
 * `sha256`/`sha256Base64` as **real enumerable own properties**.
 *
 * Unlike {@link withSha256} — a `Proxy` used by `download()` so R2's native body
 * accessors (`body`/`arrayBuffer()`/`text()`) keep working — a `list()` entry has
 * no body, and its results are routinely returned from a query and serialized to
 * the client (`JSON.stringify`). A `Proxy` over R2's **non-extensible** host
 * object cannot advertise the synthetic checksum fields as own keys (the
 * `ownKeys` Proxy invariant forbids reporting keys absent from a non-extensible
 * target), so `JSON.stringify`/spread/`Object.keys` would silently drop them. A
 * plain projection makes the fields survive the wire while losing nothing the
 * body-free {@link R2ObjectLike} surface exposes. Fields are copied by explicit
 * access (not a spread) so a host object's non-enumerable properties are still
 * captured.
 */
const toListObject = (object: R2ObjectLike): R2ObjectLike => {
    const raw = object.checksums?.sha256;

    return {
        checksums: object.checksums,
        customMetadata: object.customMetadata,
        etag: object.etag,
        httpEtag: object.httpEtag,
        httpMetadata: object.httpMetadata,
        key: object.key,
        sha256: raw === undefined ? undefined : toHex(raw),
        sha256Base64: raw === undefined ? undefined : toBase64(new Uint8Array(raw)),
        size: object.size,
        uploaded: object.uploaded,
    };
};

/**
 * Read a byte stream into a sized body, refusing it at the first chunk that
 * pushes it past `maxSize`.
 *
 * R2 accepts a `ReadableStream` only when it can read the length up front — a
 * request/response body, or the readable half of a `FixedLengthStream`. A
 * counting `TransformStream` is neither, so handing R2 the wrapped stream (what
 * this guard used to do) failed EVERY streamed upload carrying a `maxSize` with
 * "Provided readable stream must have a known length": the documented
 * `upload(key, request.body, { maxSize })` could never succeed.
 *
 * A `FixedLengthStream` is no answer either — it needs the exact byte count up
 * front, and `upload()` is handed a stream, not a length. The unknown-length
 * stream is precisely the case the cap exists to bound, so the counted bytes are
 * collected here into a `Blob`, which carries the length R2 needs. Reading stops
 * at the chunk that crosses the cap (the counter errors the stream, and the
 * `Response` drain rejects with it), so nothing oversized is buffered whole and
 * nothing reaches the bucket.
 *
 * `maxSize` is therefore also the memory ceiling for a streamed body, and it is
 * a SHARED one: the isolate's ~128 MB is spread across every concurrent request,
 * so N in-flight uploads hold up to N x `maxSize`. That is why the caller's cap
 * is itself capped at {@link MAX_BUFFERED_STREAM_SIZE} on this path. For objects
 * larger than that, use `createMultipartUpload` / `createUploadHandler`, neither
 * of which buffers the whole object.
 *
 * A non-byte chunk (no `byteLength`) can't be measured, so it errors the stream
 * rather than flowing through uncounted — otherwise it would silently defeat the
 * `maxSize` bound.
 */
const collectStreamWithinMaxSize = async (stream: ReadableStream, maxSize: number): Promise<Blob> => {
    let seen = 0;

    /**
     * Measure a chunk AND normalise it to the one shape the `Response` drain
     * below accepts. A stream may carry any BufferSource, and undici's
     * `Response` body takes only `Uint8Array` — enqueuing the original
     * ArrayBuffer/DataView/Float32Array surfaced as a bare
     * `TypeError: Received non-Uint8Array chunk` with no code and nothing
     * naming storage. (workerd accepts those shapes as-is, so only Node saw
     * it; the view is a no-op wrapper there, not a copy.) `undefined` signals
     * a non-byte chunk, whose length can't be counted.
     */
    const toBytes = (chunk: unknown): Uint8Array | undefined => {
        if (chunk instanceof ArrayBuffer) {
            return new Uint8Array(chunk);
        }

        return ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : undefined;
    };

    const counter = new TransformStream({
        transform(chunk: unknown, controller) {
            const bytes = toBytes(chunk);

            if (bytes === undefined) {
                controller.error(new LunoraError("VALIDATION_ERROR", "@lunora/storage: stream chunk is not a byte chunk; cannot enforce maxSize"));

                return;
            }

            seen += bytes.byteLength;

            if (seen > maxSize) {
                controller.error(new LunoraError("PAYLOAD_TOO_LARGE", `@lunora/storage: stream body exceeds maxSize (> ${String(maxSize)} bytes)`));

                return;
            }

            controller.enqueue(bytes);
        },
    });

    return await new Response(stream.pipeThrough(counter)).blob();
};

/**
 * Apply a `maxSize` cap, returning the body to hand R2.
 *
 * An `ArrayBuffer`/`Blob` length is known up front and refused before the upload
 * starts. A `ReadableStream`'s isn't, so it is collected under the cap and
 * handed to R2 as a sized body — see {@link collectStreamWithinMaxSize} for why
 * it can't stay a stream, and {@link MAX_BUFFERED_STREAM_SIZE} for why the
 * caller's cap is itself capped on that path.
 */
const applyMaxSize = async (body: UploadBody, maxSize: number): Promise<UploadBody> => {
    // A cap that isn't a finite, non-negative number breaks both comparisons
    // that enforce it, in opposite directions: `seen > NaN` is never true, so
    // the cap is silently off while a stream is still collected whole (an
    // unbounded in-isolate buffer — an unset byte-limit variable coerced with
    // `Number(...)` is all it takes); `seen > -1` is true on the first chunk, so
    // a negative cap refuses every upload. Both are configuration bugs, and both
    // are reported as one here rather than acted on.
    if (!Number.isFinite(maxSize) || maxSize < 0) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/storage: maxSize must be a finite, non-negative number (received ${String(maxSize)})`);
    }

    if (body instanceof ReadableStream) {
        // The ceiling is on the stream path only: it bounds what this call must
        // BUFFER, and an ArrayBuffer/Blob body is already in the caller's memory,
        // so capping it there would buy nothing.
        if (maxSize > MAX_BUFFERED_STREAM_SIZE) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `@lunora/storage: maxSize ${String(maxSize)} exceeds the ${String(MAX_BUFFERED_STREAM_SIZE)}-byte ceiling for a streamed body, which must be buffered to be capped — use createMultipartUpload() or createUploadHandler() for objects this large`,
            );
        }

        return await collectStreamWithinMaxSize(body, maxSize);
    }

    const size = body instanceof ArrayBuffer ? body.byteLength : body.size;

    if (size > maxSize) {
        throw new LunoraError("PAYLOAD_TOO_LARGE", `@lunora/storage: body exceeds maxSize (${String(size)} > ${String(maxSize)})`);
    }

    return body;
};

/** Shared encoder for measuring UTF-8 byte length (not UTF-16 `String.length`). */
const TEXT_ENCODER = new TextEncoder();

/**
 * UTF-8 byte length of a key. R2's ceiling is documented in **bytes**, so a key
 * of multi-byte (CJK/emoji) characters can sit well under 1024 UTF-16 code units
 * yet exceed 1024 bytes — `String.length` waved it through only for R2 to reject
 * it remotely, which defeats the point of validating here. `@lunora/bindings/kv`
 * already measures this way and its comment describes exactly this failure; the
 * error strings on this side said "byte limit" while counting code units.
 */
const byteLength = (value: string): number => TEXT_ENCODER.encode(value).length;

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
        throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: key must be a non-empty string");
    }

    if (byteLength(key) > MAX_KEY_LENGTH) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/storage: key exceeds ${String(MAX_KEY_LENGTH)}-byte limit`);
    }

    if (key.includes("\0")) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: key contains NUL byte");
    }

    // CR/LF (and other C0 controls) in a key would let a signed-URL canonical
    // (`shared/hmac-url.ts`, host\nkey\nexp\n...) re-split so a different
    // `exp` reads back for the same signature — reject at the point the key
    // enters storage, not just when a signed URL happens to be minted for it.
    // `hasControlChar` is the canonical detector from `shared/hmac-url.ts`, so
    // this stays in lockstep with the HMAC canonical's own guard instead of a
    // byte-similar copy that can drift.
    if (hasControlChar(key)) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: key contains a control character (including CR/LF)");
    }

    if (key.startsWith("/")) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: key must not start with `/`");
    }

    // Reject `..` as a path component (not just substring) so `a..b` is fine
    // but `a/../b`, `../b`, `b/..` are rejected.
    if (key.split("/").includes("..")) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: key contains a `..` path component");
    }
};

/**
 * Compose a per-tenant key from a scope prefix and a caller-supplied key.
 * Both halves are validated — the prefix may not contain `..` or NUL either,
 * and the resulting key must stay under R2's length ceiling. Recommended for
 * any multi-tenant deployment so client-supplied keys can't address peer data.
 */

/**
 * Enforce an `allowedContentTypes` allowlist.
 *
 * The allowlist is a security control (e.g. blocking `text/html` to prevent
 * stored XSS), so omitting `contentType` must NOT bypass it — otherwise an
 * uploader sidesteps the list by simply not declaring a type. When a list is
 * configured, a `contentType` is REQUIRED and must be a member of it.
 */
const assertContentTypeAllowed = (uploadOptions: UploadOptions): void => {
    if (uploadOptions.allowedContentTypes === undefined) {
        return;
    }

    if (uploadOptions.contentType === undefined) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: contentType is required when allowedContentTypes is set");
    }

    if (!uploadOptions.allowedContentTypes.includes(uploadOptions.contentType)) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/storage: contentType "${uploadOptions.contentType}" not in allowedContentTypes`);
    }
};

export const scopeKey = (prefix: string, key: string): string => {
    validateKey(prefix);
    validateKey(key);

    const trimmedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    const composed = `${trimmedPrefix}/${key}`;

    if (byteLength(composed) > MAX_KEY_LENGTH) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/storage: scoped key exceeds ${String(MAX_KEY_LENGTH)}-byte limit`);
    }

    return composed;
};

export const createStorage = (options: LunoraStorageOptions): Storage => {
    // Defensive runtime guard: `bucket` is required by the type, but JS callers
    // (and `createStorage({})` misuse — exercised by a test) can omit it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the type
    if (!options.bucket) {
        throw new LunoraError("INTERNAL", "@lunora/storage: `bucket` is required");
    }

    // Same guard for `bucketName`, and it fails here rather than at signing time
    // on purpose: the previous `?? "default"` fallback meant an omitted name
    // silently signed every bucket as `"default"`, so a URL minted for one
    // bucket verified against another sharing the signing secret.
    if (typeof options.bucketName !== "string" || options.bucketName === "") {
        throw new LunoraError(
            "INTERNAL",
            '@lunora/storage: `bucketName` is required — pass the name this bucket is registered under (`"default"` for a single-bucket app)',
        );
    }

    const upload = async (key: string, body: UploadBody, uploadOptions: UploadOptions = {}): Promise<{ etag: string; httpEtag: string; key: string }> => {
        validateKey(key);

        assertContentTypeAllowed(uploadOptions);

        const putBody = uploadOptions.maxSize === undefined ? body : await applyMaxSize(body, uploadOptions.maxSize);

        const object = await options.bucket.put(key, putBody, {
            customMetadata: uploadOptions.customMetadata,
            httpMetadata: uploadOptions.contentType ? { contentType: uploadOptions.contentType } : undefined,
            // Passing the digest makes R2 both verify the write and RECORD the
            // checksum, which is what later makes `list()`/`head()` able to
            // report it. Omitted, every integrity check downstream silently
            // degrades to a size comparison.
            ...(uploadOptions.sha256 === undefined ? {} : { sha256: uploadOptions.sha256 }),
        });

        // `httpEtag` is the quoted form for an HTTP `ETag` header; fall back to
        // quoting `etag` for doubles/older bindings that don't surface it.
        return { etag: object.etag, httpEtag: object.httpEtag ?? `"${object.etag}"`, key: object.key };
    };

    const download = async (key: string, downloadOptions: { range?: R2RangeLike } = {}): Promise<R2ObjectBodyLike | null> => {
        validateKey(key);

        // Forward `range` so R2 resolves the byte window server-side and streams
        // only those bytes back — the unwanted bytes never reach the Worker, so
        // a partial read of a large object doesn't buffer the whole thing. The
        // two-arg and one-arg calls are split so neither hits R2's `get` overload
        // that pairs `options` with a mandatory `onlyIf`.
        const object = await (downloadOptions.range ? options.bucket.get(key, { range: downloadOptions.range }) : options.bucket.get(key));

        // `withSha256` is a no-op (and a pass-through) for a null result, so a
        // single call covers both the hit and miss cases without a `null` literal.
        return object && withSha256(object);
    };

    const deleteObject = async (key: string): Promise<void> => {
        validateKey(key);
        await options.bucket.delete(key);
    };

    const head = async (key: string): Promise<R2ObjectLike | null> => {
        validateKey(key);

        // Prefer a true HEAD (no body transfer) when the binding exposes one.
        // Fall back to a 0-length ranged GET (`{ length: 0 }`) so we still avoid
        // streaming the body when running against a `head`-less double or runtime.
        // Either way `size` is the FULL object size — R2 reports the object's
        // size, not the returned window's — which is what makes this enough to
        // resolve a `Range` against.
        const object = options.bucket.head ? await options.bucket.head(key) : await options.bucket.get(key, { range: { length: 0 } });

        // The `toListObject` projection, not `download()`'s `withSha256` Proxy: a
        // head result has no body to keep native accessors alive for, and it IS
        // routinely returned from a query and serialized. A Proxy over R2's
        // non-extensible object cannot advertise the synthetic checksum fields as
        // own keys, so `JSON.stringify` would silently drop them on the wire.
        return object && toListObject(object);
    };

    const getMetadata = async (key: string): Promise<ObjectMetadata | null> => {
        const object = await head(key);

        return object && toMetadata(object);
    };

    const list = async (
        prefix?: string,
        listOptions: ListOptions = {},
    ): Promise<{ cursor?: string; delimitedPrefixes?: string[]; objects: R2ObjectLike[]; truncated?: boolean }> => {
        // `prefix` is intentionally permissive: it's read-only and a malformed
        // value just produces an empty result. We still reject NUL bytes since
        // the R2 binding silently truncates at the NUL on some runtimes.
        if (prefix?.includes("\0")) {
            throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: prefix contains NUL byte");
        }

        const requested = listOptions.limit ?? DEFAULT_LIST_LIMIT;
        const limit = Math.min(Math.max(1, Math.floor(requested)), MAX_LIST_LIMIT);
        const result = await options.bucket.list({
            cursor: listOptions.cursor,
            delimiter: listOptions.delimiter,
            // Under `r2_list_honor_include` (every compat date since 2022-08-04)
            // R2 omits both metadata bags from list entries unless the call asks
            // for them. `toListObject` copies them either way, so without this a
            // real bucket returned `httpMetadata: {}` / `customMetadata: {}` for
            // every entry while `head()` on the same key returned them in full.
            // The cost, documented on `Storage.list`: R2 may shrink a page to fit
            // the metadata, so a page can hold fewer than `limit` objects and
            // `objects.length < limit` does not mean the listing is finished.
            include: ["customMetadata", "httpMetadata"],
            limit,
            prefix,
        });

        // With a delimiter, R2 puts the rolled-up "folders" in `delimitedPrefixes`
        // and leaves them OUT of `objects` — dropping them made
        // `list("photos/", { delimiter: "/" })` over a bucket full of
        // `photos/2026/*.png` look like an empty directory.
        const { delimitedPrefixes } = result;

        // Forward R2's `truncated` flag so callers can paginate with a clean
        // `while (truncated)` loop instead of inferring "more" from `cursor`.
        // `toListObject` (not the `withSha256` Proxy) so `sha256`/`sha256Base64`
        // survive JSON serialization when the list is returned from a query.
        return { cursor: result.cursor, delimitedPrefixes, objects: result.objects.map((object) => toListObject(object)), truncated: result.truncated };
    };

    const getUrl = (key: string): string => {
        if (!options.publicBaseUrl) {
            throw new LunoraError("INTERNAL", "@lunora/storage: `publicBaseUrl` is required for getUrl()");
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

        return `${trimTrailingSlashes(options.publicBaseUrl)}/${safeKey}`;
    };

    const getSignedUrl = async (key: string, signedOptions: SignedUrlOptions = {}): Promise<string> => {
        if (!options.publicBaseUrl) {
            throw new LunoraError("INTERNAL", "@lunora/storage: `publicBaseUrl` is required for getSignedUrl()");
        }

        if (!options.signingSecret) {
            throw new LunoraError("INTERNAL", "@lunora/storage: `signingSecret` is required for getSignedUrl()");
        }

        validateKey(key);

        return buildSignedUrl({
            baseUrl: options.publicBaseUrl,
            bucketName: options.bucketName,
            contentType: signedOptions.contentType,
            expiresInSeconds: signedOptions.expiresInSeconds,
            key,
            method: signedOptions.method,
            secret: options.signingSecret,
        });
    };

    // Native R2 multipart upload for very large objects. Thin wrappers over the
    // binding — validate the key and surface a clear error when the bound bucket
    // doesn't support multipart (e.g. an older test double).
    const createMultipartUpload = async (
        key: string,
        multipartOptions: { contentType?: string; customMetadata?: Record<string, string> } = {},
    ): Promise<R2MultipartUploadLike> => {
        validateKey(key);

        if (!options.bucket.createMultipartUpload) {
            throw new LunoraError("INTERNAL", "@lunora/storage: bucket binding does not support multipart uploads (createMultipartUpload)");
        }

        return options.bucket.createMultipartUpload(key, {
            customMetadata: multipartOptions.customMetadata,
            httpMetadata: multipartOptions.contentType ? { contentType: multipartOptions.contentType } : undefined,
        });
    };

    const resumeMultipartUpload = (key: string, uploadId: string): R2MultipartUploadLike => {
        validateKey(key);

        if (typeof uploadId !== "string" || uploadId.length === 0) {
            throw new LunoraError("VALIDATION_ERROR", "@lunora/storage: resumeMultipartUpload requires a non-empty uploadId");
        }

        if (!options.bucket.resumeMultipartUpload) {
            throw new LunoraError("INTERNAL", "@lunora/storage: bucket binding does not support multipart uploads (resumeMultipartUpload)");
        }

        return options.bucket.resumeMultipartUpload(key, uploadId);
    };

    // Native S3 presigned URL — hits R2 directly, bypassing the Worker. Requires
    // R2 S3 credentials; the worker-signed path (`getSignedUrl`) needs none.
    const getPresignedUrl = async (key: string, presignedOptions: PresignedUrlOptions = {}): Promise<string> => {
        if (!options.s3) {
            throw new LunoraError(
                "INTERNAL",
                "@lunora/storage: `s3` credentials are required for getPresignedUrl() — pass { accountId, accessKeyId, secretAccessKey, bucket }",
            );
        }

        validateKey(key);

        return buildPresignedUrl({
            credentials: options.s3,
            expiresInSeconds: presignedOptions.expiresInSeconds,
            key,
            method: presignedOptions.method,
        });
    };

    // Convex-compatible aliases over the primitives above. `generateUploadUrl`
    // mints a signed PUT (optionally pinning the content-type into the signature).
    const generateUploadUrl = async (key: string, uploadUrlOptions: { contentType?: string; expiresInSeconds?: number } = {}): Promise<string> =>
        getSignedUrl(key, { contentType: uploadUrlOptions.contentType, expiresInSeconds: uploadUrlOptions.expiresInSeconds, method: "PUT" });

    return {
        bucketName: options.bucketName,
        createMultipartUpload,
        delete: deleteObject,
        download,
        generateUploadUrl,
        getMetadata,
        getPresignedUrl,
        getSignedUrl,
        getUrl,
        head,
        list,
        resumeMultipartUpload,
        // `store` is `upload` under Convex's name — the same function, so the
        // `maxSize` / `allowedContentTypes` guards apply through the alias too.
        store: upload,
        upload,
    };
};
