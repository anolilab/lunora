import type { RateLimitConfigMap } from "@lunora/ratelimit";
import { createDbStore, rateLimit, RateLimiter } from "@lunora/ratelimit";

import { action, query, v } from "./_generated/server.js";

// 20 upload-URL mints per minute per user, durable via the DB-backed store.
const limits: RateLimitConfigMap = { uploadAvatar: { kind: "token bucket", period: 60_000, rate: 20 } };

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
        contentType: v.string().meta({ schema: { maxLength: 128 } }),
        key: v.string().meta({ schema: { maxLength: 256 } }),
    })
    .use(
        rateLimit((ctx) => new RateLimiter({ config: limits, store: createDbStore({ db: ctx.db }) }), "uploadAvatar", {
            key: (ctx) => ctx.auth.userId ?? "anonymous",
        }),
    )
    .action(async ({ args, ctx }): Promise<{ key: string; url: string }> => {
        const userId = ctx.auth.userId ?? "anonymous";
        const scopedKey = `avatars/${userId}/${args.key}`;
        // A `PUT` URL with the content-type pinned into the HMAC — the client must
        // upload with exactly this `Content-Type`.
        const url = await ctx.storage.generateUploadUrl(scopedKey, { contentType: args.contentType, expiresInSeconds: 60 });

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
