import emit from "../../finding";
import type { Lint } from "../../types";

/** `ctx.storage` methods that accept the `UploadOptions` `allowedContentTypes` guard. */
const UPLOAD_METHODS = new Set(["store", "upload"]);

/**
 * Flags a `ctx.storage.upload`/`store` call whose options argument omits
 * `allowedContentTypes`.
 *
 * `@lunora/storage`'s `upload`/`store` accept an `allowedContentTypes`
 * allowlist that, when set, rejects a mismatched (or missing) `contentType` —
 * the control that stops an uploader from storing `text/html` or
 * `image/svg+xml` and having it served back from `publicBaseUrl`, a classic
 * stored-XSS path against your own origin. Omitting the option leaves any
 * content-type acceptable. `generateUploadUrl`'s signed PUT has no
 * `allowedContentTypes` option at all (it bypasses `upload()`'s guards
 * entirely) — that gap is `storage_generate_upload_url_no_content_type_pin`'s
 * concern, not this lint's.
 *
 * Runs only when the codegen feeder supplies storage-upload evidence
 * (`context.storageUploads`); a runtime caller flags nothing. Skips calls
 * whose options argument wasn't statically analyzable (a variable, call
 * result, or a spread) — the key may be set on an object built elsewhere. One
 * finding per unguarded call.
 */
const storageUploadWithoutContentTypeAllowlist: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.storage.upload`/`store` call has no `allowedContentTypes` allowlist, so an uploader can store any content-type — including `text/html` or `image/svg+xml` — which, served back from `publicBaseUrl`, is a stored-XSS vector against your own origin.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "storage_upload_without_content_type_allowlist",
    remediation:
        'Pass `allowedContentTypes: ["image/png", "image/jpeg", …]` to `ctx.storage.upload`/`store` so an uploaded object\'s `contentType` must match an approved list. Reject anything HTML/SVG/script-executable unless the app genuinely needs to serve it.',
    run: (context) => {
        if (context.storageUploads === undefined) {
            return [];
        }

        return context.storageUploads
            .filter((row) => UPLOAD_METHODS.has(row.method) && row.analyzable && !row.presentKeys.includes("allowedContentTypes"))
            .map((row) =>
                emit(storageUploadWithoutContentTypeAllowlist, {
                    cacheKey: `storage_upload_without_content_type_allowlist:${row.file}:${row.line.toString()}`,
                    detail: `\`ctx.storage.${row.method}\` in \`${row.exportName}\` (${row.file}:${row.line.toString()}) has no \`allowedContentTypes\` allowlist — any content-type is accepted, including \`text/html\`/\`image/svg+xml\`, a stored-XSS risk if the object is served from \`publicBaseUrl\`.`,
                    metadata: { exportName: row.exportName, file: row.file, line: row.line, method: row.method },
                }),
            );
    },
    source: "static",
    title: "Storage upload with no content-type allowlist",
};

export default storageUploadWithoutContentTypeAllowlist;
