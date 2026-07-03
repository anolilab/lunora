import emit from "../../finding";
import type { AdvisorStorageUpload } from "../../storage-uploads";
import type { Lint } from "../../types";

/** The two `ctx.storage` URL signers whose `expiresInSeconds` shares R2/S3's 7-day ceiling. */
const SIGNER_METHODS = new Set(["getPresignedUrl", "getSignedUrl"]);

/**
 * "Near" `@lunora/storage`'s 7-day (604800s) `expiresInSeconds` ceiling — 6
 * days, i.e. within a day of the maximum. A URL minted this long-lived stays
 * valid almost as long as the signer allows, closing most of the gap a
 * shorter, rotated TTL would otherwise provide.
 */
const NEAR_MAX_EXPIRES_THRESHOLD_SECONDS = 6 * 24 * 60 * 60;

/** `true` when `row` is a native S3 presigned-URL call — it resolves directly against R2, bypassing the Worker entirely. */
const isNativePresignedCall = (row: AdvisorStorageUpload): boolean => row.method === "getPresignedUrl";

/** `true` when `row` is either signer minting a URL with a statically-known `expiresInSeconds` near the shared 7-day ceiling. */
const isNearExpiryCeiling = (row: AdvisorStorageUpload): boolean =>
    SIGNER_METHODS.has(row.method) && row.expiresInSeconds !== undefined && row.expiresInSeconds >= NEAR_MAX_EXPIRES_THRESHOLD_SECONDS;

/**
 * Flags a `ctx.storage.getPresignedUrl(...)` call, or a `getPresignedUrl`/
 * `getSignedUrl` call whose `expiresInSeconds` sits near the shared 7-day
 * signing ceiling.
 *
 * `getPresignedUrl` mints a native S3 SigV4 URL that resolves directly
 * against R2's S3 endpoint — the holder reaches the object straight off R2,
 * **bypassing the Worker entirely**, so any auth/RLS/rate-limit gate the app
 * enforces in its own handlers never runs for that request. That's the right
 * trade for genuinely public or bulk content where the app has no per-request
 * gating to apply; it's the wrong choice for private, per-user, or
 * policy-gated content, where `getSignedUrl` (worker-signed, resolves back
 * through the app) is the fit. Separately, either signer minting a long TTL
 * near the shared 7-day ceiling hands out a bearer credential that stays
 * valid almost as long as the platform allows — a leaked link (referrer,
 * logs, browser history) then grants access for nearly a week.
 *
 * Runs only when the codegen feeder supplies storage-upload evidence
 * (`context.storageUploads`); a runtime caller flags nothing. The
 * near-ceiling check only fires on a statically-known numeric
 * `expiresInSeconds` literal — a variable or computed expression is not
 * evaluated, to keep the false-positive rate low. One finding per matching
 * call.
 */
const storagePresignedUrlForPrivateContent: Lint = {
    categories: ["SECURITY"],
    description:
        "`ctx.storage.getPresignedUrl(...)` mints a native S3 SigV4 URL that resolves directly against R2, bypassing the Worker's auth/RLS/rate-limit entirely — the wrong choice for private or policy-gated content. Either signer minting an `expiresInSeconds` near the shared 7-day ceiling also hands out a long-lived bearer credential.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "storage_presigned_url_for_private_content",
    remediation:
        "For private/per-user/policy-gated content, use `getSignedUrl` (resolves back through the Worker, so your auth/RLS/rate-limit gates still run) instead of `getPresignedUrl`. Reserve `getPresignedUrl` for genuinely public or bulk content. On either signer, keep `expiresInSeconds` as short as the use case allows — well under the 7-day ceiling — rather than minting a near-maximum-lifetime URL.",
    run: (context) => {
        if (context.storageUploads === undefined) {
            return [];
        }

        return context.storageUploads
            .filter((row) => isNativePresignedCall(row) || isNearExpiryCeiling(row))
            .map((row) => {
                const native = isNativePresignedCall(row);
                const nearCeiling = isNearExpiryCeiling(row);
                const location = `\`${row.exportName}\` (${row.file}:${row.line.toString()})`;

                let detail: string;

                if (native && nearCeiling) {
                    detail = `\`ctx.storage.getPresignedUrl\` in ${location} mints a native S3 SigV4 URL — bypasses the Worker's auth/RLS/rate-limit entirely — with an \`expiresInSeconds\` of ${(row.expiresInSeconds ?? 0).toString()}s, near the 7-day signing ceiling.`;
                } else if (native) {
                    detail = `\`ctx.storage.getPresignedUrl\` in ${location} mints a native S3 SigV4 URL that resolves directly against R2, bypassing the Worker's auth/RLS/rate-limit entirely. Use \`getSignedUrl\` for app-gated access to private content.`;
                } else {
                    detail = `\`ctx.storage.${row.method}\` in ${location} requests an \`expiresInSeconds\` of ${(row.expiresInSeconds ?? 0).toString()}s, near the 7-day signing ceiling — a leaked link stays valid for almost a week.`;
                }

                return emit(storagePresignedUrlForPrivateContent, {
                    cacheKey: `storage_presigned_url_for_private_content:${row.file}:${row.line.toString()}`,
                    detail,
                    metadata: {
                        expiresInSeconds: row.expiresInSeconds,
                        exportName: row.exportName,
                        file: row.file,
                        line: row.line,
                        method: row.method,
                    },
                });
            });
    },
    source: "static",
    title: "Native presigned URL or near-max-TTL signed URL for private content",
};

export default storagePresignedUrlForPrivateContent;
