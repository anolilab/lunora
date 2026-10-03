"use client";

/**
 * `@lunora/react/upload` — end-user file-upload hooks.
 *
 * A thin re-export of `@visulima/storage-client`'s React upload hooks (Lunora
 * does not hand-roll the uploader). `useUpload` auto-selects TUS / chunked-REST /
 * multipart by file size; the TUS path gives live progress, pause/resume and
 * resume-after-a-dropped-connection. Point the hook's endpoint at a route backed
 * by `@lunora/storage/upload`'s RLS-gated handler — end-user uploads gated by
 * _your_ per-user policy, not an `adminToken`.
 *
 * ### TanStack Query
 *
 * The upload hooks re-exported here (`useUpload`, `useMultipartUpload`,
 * `useTusUpload`, `useChunkedRestUpload`, `useFileInput`, `usePasteUpload`) hold
 * their own state and need no `QueryClientProvider`, so Lunora's own `useQuery`
 * and the visulima upload hooks coexist: the upload hooks never touch the query
 * cache. `@visulima/storage-client`'s _data_ hooks (`useGetFileList` etc.) are
 * not re-exported: they read files over `GET` on the upload route, which
 * `@lunora/storage/upload` refuses (`405`). Read stored files through
 * `ctx.storage` or a signed URL.
 */
// The unified control handle + typed errors + restriction guards live on the
// framework-agnostic core entry, not the React entry — surface them here so a
// React-only user gets everything from one import.
export type { UploadRestrictions } from "@visulima/storage-client";
export { RestrictionError, UploadControl, UploadError } from "@visulima/storage-client";
export type {
    UploadMethod,
    UploadResult,
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
} from "@visulima/storage-client/react";
export { useChunkedRestUpload, useFileInput, useMultipartUpload, usePasteUpload, useTusUpload, useUpload } from "@visulima/storage-client/react";
