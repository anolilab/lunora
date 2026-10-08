/**
 * `@lunora/storage/upload` — the RLS-gated, non-admin resumable upload handler.
 *
 * A separate subpath so the base `@lunora/storage` entry stays lean: the
 * `@visulima/storage` handler dependency only loads for apps that mount an
 * end-user upload endpoint. Pair with `@visulima/storage-client` (or the
 * `@lunora/react` / `@lunora/vue` / … `useUpload` re-exports) on the client.
 *
 * On Workers this subpath statically imports `node:async_hooks` (the grant
 * scope) and, through the R2 providers, `node:stream`, so it needs Node.js
 * compatibility to load at all: the import fails at load time otherwise, and
 * the subpath never reaches `createUploadHandler` / `createUploadContext`. A
 * `compatibility_date` of `2026-08-04` or later enables `nodejs_compat` by
 * default; earlier dates need `nodejs_compat` in `compatibility_flags`.
 * `nodejs_als` alone satisfies the `AsyncLocalStorage` import but not
 * `node:stream`, so it is not enough for this subpath. Node.js is unaffected.
 */
export type { R2BindingUploadStorageOptions, R2UploadBucket } from "./r2-binding-upload-storage";
export { createR2BindingUploadStorage, R2_PART_SIZE } from "./r2-binding-upload-storage";
export type { R2UploadStorageOptions } from "./r2-s3-upload-storage";
export { createR2UploadStorage } from "./r2-s3-upload-storage";
export type {
    CreateUploadHandlerOptions,
    UploadAuthorizeResult,
    UploadAuthzContext,
    UploadContext,
    UploadGrant,
    UploadHandler,
    UploadProtocol,
    UploadSizeContext,
    UploadStorage,
} from "./upload-handler";
export { createUploadContext, createUploadHandler, DEFAULT_MAX_UPLOAD_BYTES } from "./upload-handler";
