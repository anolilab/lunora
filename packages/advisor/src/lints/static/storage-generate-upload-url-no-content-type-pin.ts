import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `ctx.storage.generateUploadUrl(key, …)` call whose options argument
 * omits `contentType`.
 *
 * `generateUploadUrl` mints a signed `PUT` URL the *client* uploads directly
 * to R2, bypassing `upload()`/`store()` entirely — including their
 * `allowedContentTypes`/`maxSize` guards, which this alias never sees. The one
 * guard `generateUploadUrl` itself offers is `contentType`: passing it pins
 * the `Content-Type` into the signature, so the signed URL only authorizes a
 * PUT with exactly that content-type. Omit it and the minted URL accepts any
 * content-type/size the client chooses, entirely unchecked server-side.
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
        "A `ctx.storage.generateUploadUrl(key, …)` call has no `contentType` pin, so the signed PUT URL it mints authorizes any content-type/size the client chooses — `upload()`'s `allowedContentTypes`/`maxSize` guards never run for a client-side PUT against this URL.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "storage_generate_upload_url_no_content_type_pin",
    remediation:
        "Pass `contentType` to `ctx.storage.generateUploadUrl(key, { contentType })` so the signature only authorizes a PUT with that exact content-type. If the client's upload size/type also needs bounding, prefer `upload()`/`store()` (with `allowedContentTypes`/`maxSize`) over a client-side signed PUT.",
    run: (context) => {
        if (context.storageUploads === undefined) {
            return [];
        }

        return context.storageUploads
            .filter((row) => row.method === "generateUploadUrl" && row.analyzable && !row.presentKeys.includes("contentType"))
            .map((row) =>
                emit(storageGenerateUploadUrlNoContentTypePin, {
                    cacheKey: `storage_generate_upload_url_no_content_type_pin:${row.file}:${row.line.toString()}`,
                    detail: `\`ctx.storage.generateUploadUrl\` in \`${row.exportName}\` (${row.file}:${row.line.toString()}) has no \`contentType\` pin — the signed PUT it mints accepts any type/size, minted client-side and bypassing \`upload()\`'s guards.`,
                    metadata: { exportName: row.exportName, file: row.file, line: row.line },
                }),
            );
    },
    source: "static",
    title: "generateUploadUrl signed PUT with no content-type pin",
};

export default storageGenerateUploadUrlNoContentTypePin;
