import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `ctx.storage.generateUploadUrl(key, …)` call whose options argument
 * omits `contentType`.
 *
 * `generateUploadUrl` is `getSignedUrl(key, { method: "PUT" })`: it mints a
 * signed PUT URL the *client* uploads with, bypassing `upload()`/`store()`
 * entirely — including their `allowedContentTypes`/`maxSize` guards, which this
 * alias never sees. The one guard it offers is `contentType`, which
 * `buildSignedUrl` binds into the HMAC canonical (PUT only) and
 * `verifySignedUrl` returns as `contentType` on a valid verdict.
 *
 * Note what that does and does not buy. Binding it means the pin cannot be
 * swapped without breaking the signature, so the URL is scoped to one declared
 * content-type. It does NOT by itself reject a mismatched upload: nothing in
 * `@lunora/storage` compares the pin against the request's actual
 * `Content-Type` — the PUT route you mount at `publicBaseUrl` does, by checking
 * `verifySignedUrl`'s `contentType` against the inbound header. Omit the pin
 * and there is nothing to check against at all, and no size bound either way.
 *
 * Runs only when the codegen feeder supplies storage-upload evidence
 * (`context.storageUploads`); a runtime caller flags nothing. Skips calls
 * whose options argument wasn't statically analyzable (a variable, call
 * result, or a spread) — the key may be set on an object built elsewhere. One
 * finding per unpinned call.
 */
const storageGenerateUploadUrlNoContentTypePin: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.storage.generateUploadUrl(key, …)` call has no `contentType` pin, so the signed PUT URL it mints declares no expected content-type for the serving route to check — `upload()`'s `allowedContentTypes`/`maxSize` guards never run for a client-side PUT against this URL.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "storage_generate_upload_url_no_content_type_pin",
    remediation:
        "Pass `contentType` to `ctx.storage.generateUploadUrl(key, { contentType })` so the signature is scoped to that content-type, and have your PUT route reject a request whose `Content-Type` differs from `verifySignedUrl`'s returned `contentType` — the pin is bound into the signature, but nothing in `@lunora/storage` compares it to the upload for you. If the size also needs bounding, prefer `upload()`/`store()` (with `allowedContentTypes`/`maxSize`) over a client-side signed PUT.",
    run: (context) => {
        if (context.storageUploads === undefined) {
            return [];
        }

        return context.storageUploads
            .filter((row) => row.method === "generateUploadUrl" && row.analyzable && !row.presentKeys.includes("contentType"))
            .map((row) =>
                emit(storageGenerateUploadUrlNoContentTypePin, {
                    cacheKey: `storage_generate_upload_url_no_content_type_pin:${row.file}:${row.line.toString()}`,
                    detail: `\`ctx.storage.generateUploadUrl\` in \`${row.exportName}\` (${row.file}:${row.line.toString()}) has no \`contentType\` pin — the signed PUT it mints declares no expected type for the serving route to check, and bypasses \`upload()\`'s \`allowedContentTypes\`/\`maxSize\` guards.`,
                    metadata: { exportName: row.exportName, file: row.file, line: row.line },
                }),
            );
    },
    source: "static",
    title: "generateUploadUrl signed PUT with no content-type pin",
};

export default storageGenerateUploadUrlNoContentTypePin;
