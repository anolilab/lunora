/**
 * One tracked `ctx.storage.<bucket>.<method>(...)` upload/signing call — the
 * shared input for the storage config-hygiene security lints
 * (`storage_upload_without_content_type_allowlist`, `storage_upload_without_max_size`,
 * `storage_generate_upload_url_no_content_type_pin`, `storage_presigned_url_for_private_content`).
 * `upload`/`store` carry the `UploadOptions` guards (`allowedContentTypes` /
 * `maxSize`); `generateUploadUrl` carries the signed-PUT `contentType` pin;
 * `getPresignedUrl`/`getSignedUrl` carry a statically-known `expiresInSeconds`
 * literal. `presentKeys` is empty (and `expiresInSeconds` unset) when the
 * options argument was absent, a non-literal, or a spread — see `analyzable`.
 * Produced by the codegen feeder; runtime callers don't supply it, so the
 * lints find nothing there.
 */
export interface AdvisorStorageUpload {
    /** `true` when the call's options-object argument (or its deliberate absence) was statically resolvable. */
    analyzable: boolean;
    /** Numeric literal value of an `expiresInSeconds` option, when statically known (`getSignedUrl` / `getPresignedUrl` only). */
    expiresInSeconds?: number;
    /** The exported binding name of the procedure performing the call. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
    /** The `ctx.storage` method invoked. */
    method: "generateUploadUrl" | "getPresignedUrl" | "getSignedUrl" | "store" | "upload";
    /** Options-object keys present at the call site (empty when not `analyzable`, or when no options argument was passed). */
    presentKeys: string[];
}
