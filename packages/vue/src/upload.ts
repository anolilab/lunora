/**
 * `@lunora/vue/upload` — end-user file-upload composables.
 *
 * A thin re-export of `@visulima/storage-client`'s Vue upload composables
 * (Lunora does not hand-roll the uploader). `useUpload` auto-selects TUS /
 * chunked-REST / multipart by file size; the TUS path gives live progress,
 * pause/resume and resume-after-a-dropped-connection. Point the endpoint at a
 * route backed by `@lunora/storage/upload`'s RLS-gated handler.
 *
 * The upload composables hold their own state and need no `@tanstack/vue-query`
 * provider; only `@visulima/storage-client`'s data composables do.
 */
// `UploadMethod` / `UploadResult` / `UploadRestrictions` are shared across
// frameworks and live on the core entry (the `/vue` entry keeps them internal).
export type { UploadMethod, UploadRestrictions, UploadResult } from "@visulima/storage-client";
export { RestrictionError, UploadControl, UploadError } from "@visulima/storage-client";
export type {
    UseChunkedRestUploadOptions,
    UseChunkedRestUploadReturn,
    UseFileInputOptions,
    UseFileInputReturn,
    UseMultipartUploadOptions,
    UseMultipartUploadReturn,
    UsePasteUploadOptions,
    UsePasteUploadReturn,
    UseTusUploadOptions,
    UseTusUploadReturn,
    UseUploadOptions,
    UseUploadReturn,
} from "@visulima/storage-client/vue";
export { useChunkedRestUpload, useFileInput, useMultipartUpload, usePasteUpload, useTusUpload, useUpload } from "@visulima/storage-client/vue";
