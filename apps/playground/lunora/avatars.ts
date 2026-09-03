import type { RateLimitConfigMap } from "@lunora/ratelimit";
import { dbRateLimit } from "@lunora/ratelimit";
import { LunoraError } from "lunorash/server";

import { action, query, v } from "./_generated/server.js";

// 20 upload-URL mints per minute per user, durable via the DB-backed store.
const limits = { uploadAvatar: { kind: "token bucket", period: 60_000, rate: 20 } } satisfies RateLimitConfigMap;

/**
 * Issue a short-lived PUT signed URL so the browser can upload an avatar
 * directly to R2 without proxying through the Worker. The key is namespaced
 * under the caller's user id so we don't collide across tenants. This is an
 * `action` because minting an upload URL (`generateUploadUrl`) is a write-side
 * capability — queries/mutations only get the read-only storage surface.
 *
 * `.use(rateLimit(...))` caps how fast a caller can mint upload URLs.
 */
export const uploadAvatar = action
    .input({
        contentType: v.string().max(128),
        key: v.string().max(256),
    })
    .use(dbRateLimit(limits, "uploadAvatar", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anonymous" }))
    .action(async ({ args, ctx }): Promise<{ key: string; url: string }> => {
        const userId = ctx.auth.userId ?? "anonymous";
        const scopedKey = `avatars/${userId}/${args.key}`;

        // A `PUT` URL with the content-type pinned into the HMAC — the client must
        // upload with exactly this `Content-Type`. Wrapped because R2 is an
        // outbound dependency: an unwrapped failure reaches the browser as a bare
        // stack with nothing naming which service was unreachable.
        let url: string;

        try {
            url = await ctx.storage.generateUploadUrl(scopedKey, { contentType: args.contentType, expiresInSeconds: 60 });
        } catch (error) {
            throw new LunoraError("INTERNAL", "could not mint an avatar upload URL: object storage did not answer", { cause: error });
        }

        // The key is `avatars/<userId>/<name>` — logging it logs the identity.
        // Content type and TTL are what a failed upload actually needs.
        ctx.log.info("avatar upload url minted", { contentType: args.contentType, expiresInSeconds: 60 });

        return { key: scopedKey, url };
    });

/**
 * Resolve a short-lived signed GET URL for a user's avatar. Modelled as a
 * query because the result is HMAC-derived from the key and the bucket is
 * never written to — the `ReadOnlyStorage` projection on `QueryCtx` is
 * sufficient.
 */
export const getAvatar = query.query(async ({ ctx }): Promise<{ url: string }> => {
    // Resolve the *caller's* avatar — the same `auth.userId` scoping
    // `uploadAvatar` writes under, so a signed GET round-trips to the object
    // that was just uploaded.
    const userId = ctx.auth.userId ?? "anonymous";
    const scopedKey = `avatars/${userId}/profile`;
    const url = await ctx.storage.getSignedUrl(scopedKey, { expiresInSeconds: 5 * 60 });

    return { url };
});
