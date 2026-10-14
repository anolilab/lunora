/**
 * `@lunora/solid/upload` — end-user file-upload primitives.
 *
 * A thin re-export of `@visulima/storage-client`'s Solid upload primitives
 * (Lunora does not hand-roll the uploader). `createUpload` auto-selects TUS /
 * chunked-REST / multipart by file size; the TUS path gives live progress,
 * pause/resume and resume-after-a-dropped-connection. Point the endpoint at a
 * route backed by `@lunora/storage/upload`'s RLS-gated handler.
 *
 * The upload primitives hold their own state and need no `@tanstack/solid-query`
 * provider; only `@visulima/storage-client`'s data primitives do.
 */
// `UploadMethod` / `UploadResult` / `UploadRestrictions` are shared across
// frameworks and live on the core entry (the `/solid` entry keeps them internal).
export type { UploadMethod, UploadRestrictions, UploadResult } from "@visulima/storage-client";
export { RestrictionError, UploadControl, UploadError } from "@visulima/storage-client";
export type {
    CreateChunkedRestUploadOptions,
    CreateChunkedRestUploadReturn,
    CreateFileInputOptions,
    CreateFileInputReturn,
    CreateMultipartUploadOptions,
    CreateMultipartUploadReturn,
    CreatePasteUploadOptions,
    CreatePasteUploadReturn,
    CreateTusUploadOptions,
    CreateTusUploadReturn,
    CreateUploadOptions,
    CreateUploadReturn,
} from "@visulima/storage-client/solid";
export {
    createChunkedRestUpload,
    createFileInput,
    createMultipartUpload,
    createPasteUpload,
    createTusUpload,
    createUpload,
} from "@visulima/storage-client/solid";
