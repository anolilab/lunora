import emit from "../../finding";
import type { Lint } from "../../types";

/** `ctx.storage` methods that accept the `UploadOptions` `maxSize` guard. */
const UPLOAD_METHODS = new Set(["store", "upload"]);

/**
 * Flags a `ctx.storage.upload`/`store` call whose options argument omits
 * `maxSize`.
 *
 * `@lunora/storage`'s `upload`/`store` accept a `maxSize` byte ceiling that
 * rejects an oversized `ArrayBuffer`/`Blob` up front, and reads a
 * `ReadableStream` only as far as the cap before refusing it — without it, a
 * caller can push an unbounded body through the Worker straight into R2,
 * exhausting storage/billing (and, for a streamed body, worker CPU/time) with
 * no cap.
 *
 * The remediation deliberately does NOT offer "omit `maxSize`" as the way to
 * handle a large object, which would be a suggestion to do the thing this lint
 * fires on. Storage caps `maxSize` on the streaming path at what one isolate can
 * buffer, so above that the answer is the multipart/presigned path — which is
 * outside {@link UPLOAD_METHODS} and so is never flagged here.
 *
 * Runs only when the codegen feeder supplies storage-upload evidence
 * (`context.storageUploads`); a runtime caller flags nothing. Skips calls
 * whose options argument wasn't statically analyzable (a variable, call
 * result, or a spread) — the key may be set on an object built elsewhere. One
 * finding per unbounded call.
 */
const storageUploadWithoutMaxSize: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.storage.upload`/`store` call has no `maxSize` cap, so a caller can push an unbounded body straight into R2 through the Worker — unbounded storage/billing exhaustion, and for a streamed body, unbounded worker time.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "storage_upload_without_max_size",
    remediation:
        "Pass a `maxSize` (bytes) to `ctx.storage.upload`/`store` sized to the largest legitimate object the app accepts. `ArrayBuffer`/`Blob` bodies are rejected up front when oversized; a `ReadableStream` body is read only as far as the cap and refused once it is exceeded, so nothing oversized reaches the bucket. A streamed body must be buffered to be capped, so `maxSize` is also the per-request memory ceiling and is itself capped at 16 MiB on that path — if the app legitimately accepts objects larger than that, upload them with `ctx.storage.createMultipartUpload()` or a presigned `createUploadHandler()` (neither is flagged by this lint, and neither holds the whole object) rather than dropping the cap.",
    run: (context) => {
        if (context.storageUploads === undefined) {
            return [];
        }

        return context.storageUploads
            .filter((row) => UPLOAD_METHODS.has(row.method) && row.analyzable && !row.presentKeys.includes("maxSize"))
            .map((row) =>
                emit(storageUploadWithoutMaxSize, {
                    cacheKey: `storage_upload_without_max_size:${row.file}:${row.line.toString()}`,
                    detail: `\`ctx.storage.${row.method}\` in \`${row.exportName}\` (${row.file}:${row.line.toString()}) has no \`maxSize\` cap — a caller can push an unbounded body into R2, exhausting storage/billing.`,
                    metadata: { exportName: row.exportName, file: row.file, line: row.line, method: row.method },
                }),
            );
    },
    source: "static",
    title: "Storage upload with no size cap",
};

export default storageUploadWithoutMaxSize;
