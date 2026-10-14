/**
 * `@lunora/client/upload` — framework-agnostic client upload core.
 *
 * The admin `uploadStorageObject` path on `LunoraClient` is a one-shot PUT gated
 * by an `adminToken` — right for the Studio file browser, wrong for end users.
 * This module gives end-user browsers progress, pause/resume, large-file
 * resumable uploads and per-part retry by re-exporting `@visulima/storage-client`
 * (Lunora does not hand-roll the uploader). Point {@link createUpload} at a route
 * backed by `@lunora/storage/upload`'s RLS-gated handler.
 *
 * Framework users should prefer the hook re-exports (`@lunora/react` `useUpload`,
 * `@lunora/vue`, `@lunora/solid`, `@lunora/svelte`); this vanilla core is for
 * non-framework code and for the hooks to build on.
 */
import type {
    ChunkedRestAdapter,
    ChunkedRestAdapterOptions,
    HeadersResolver,
    MultipartAdapter,
    MultipartAdapterOptions,
    TusAdapter,
    TusAdapterOptions,
    UploadControl,
    UploadRestrictions,
} from "@visulima/storage-client";
import { createChunkedRestAdapter, createMultipartAdapter, createTusAdapter } from "@visulima/storage-client";

export type {
    ChunkedRestAdapter,
    ChunkedRestAdapterOptions,
    FingerprintFunction,
    HeadersResolver,
    MultipartAdapter,
    MultipartAdapterOptions,
    OnBeforeRequest,
    RequestOptions,
    TusAdapter,
    TusAdapterOptions,
    Uploader,
    UploadMethod,
    UploadRestrictions,
    UploadResult,
    UrlStorage,
} from "@visulima/storage-client";
export {
    createChunkedRestAdapter,
    createMultipartAdapter,
    createTusAdapter,
    LocalStorageUrlStorage,
    MemoryUrlStorage,
    putFile,
    RestrictionError,
    UploadControl,
    UploadError,
    validateFile,
    validateFiles,
} from "@visulima/storage-client";

/** Resumable upload wire protocols {@link createUpload} can drive. */
export type UploadProtocol = "chunked-rest" | "multipart" | "tus";

/** The adapter shape {@link createUpload} returns — a `.upload(file)` driver plus lifecycle callbacks. */
export type UploadAdapter = ChunkedRestAdapter | MultipartAdapter | TusAdapter;

/** Options for {@link createUpload}. */
export interface CreateUploadOptions {
    /** Chunk size in bytes (TUS / chunked-REST only). */
    chunkSize?: number;
    /** A shared {@link UploadControl} for pause/resume/cancel (TUS / chunked-REST). */
    control?: UploadControl;
    /** The upload endpoint — a route backed by `@lunora/storage/upload`'s handler. */
    endpoint: string;
    /** Static or dynamically-resolved request headers (e.g. an `Authorization` token). */
    headers?: HeadersResolver;
    /** Maximum retry attempts (TUS / chunked-REST, when `retry` is on). */
    maxRetries?: number;
    /** Extra metadata sent with the upload. */
    metadata?: Record<string, string>;
    /** Which protocol to speak. Default `"tus"` (resumable, pause/resume-capable). */
    protocol?: UploadProtocol;
    /** Client-side size/type restrictions, validated before any network request. */
    restrictions?: UploadRestrictions;
    /** Enable automatic retry on failure (TUS / chunked-REST). */
    retry?: boolean;
}

/**
 * Create a protocol-appropriate upload adapter against an RLS-gated endpoint.
 * Defaults to TUS — the resumable path that survives pause/resume and a dropped
 * connection. Call `.upload(file)` to start; use the shared {@link UploadControl}
 * (or the adapter's `pause`/`resume`/`abort`) to steer it.
 */
export const createUpload = (options: CreateUploadOptions): UploadAdapter => {
    const protocol = options.protocol ?? "tus";
    const { chunkSize, control, endpoint, headers, maxRetries, metadata, restrictions, retry } = options;

    // `exactOptionalPropertyTypes` is off, so passing `undefined` for an omitted
    // option is equivalent to leaving it out — no conditional-spread dance needed.
    if (protocol === "multipart") {
        const multipartOptions: MultipartAdapterOptions = { endpoint, headers, maxRetries, metadata, restrictions, retry };

        return createMultipartAdapter(multipartOptions);
    }

    const resumableOptions: ChunkedRestAdapterOptions & TusAdapterOptions = {
        chunkSize,
        control,
        endpoint,
        headers,
        maxRetries,
        metadata,
        restrictions,
        retry,
    };

    return protocol === "chunked-rest" ? createChunkedRestAdapter(resumableOptions) : createTusAdapter(resumableOptions);
};
