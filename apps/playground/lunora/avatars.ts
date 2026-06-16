import { action, query, v } from "./_generated/server.js";

/**
 * Issue a short-lived PUT signed URL so the browser can upload an avatar
 * directly to R2 without proxying through the Worker. The key is namespaced
 * under the caller's user id so we don't collide across tenants. This is an
 * `action` because minting an upload URL (`generateUploadUrl`) is a write-side
 * capability — queries/mutations only get the read-only storage surface.
 */
export const uploadAvatar = action({
    args: {
        contentType: v.string().meta({ schema: { maxLength: 128 } }),
        key: v.string().meta({ schema: { maxLength: 256 } }),
    },
    handler: async (context, { contentType, key }): Promise<{ key: string; url: string }> => {
        const userId = context.auth.userId ?? "anonymous";
        const scopedKey = `avatars/${userId}/${key}`;
        // A `PUT` URL with the content-type pinned into the HMAC — the client must
        // upload with exactly this `Content-Type`.
        const url = await context.storage.generateUploadUrl(scopedKey, { contentType, expiresInSeconds: 60 });

        return { key: scopedKey, url };
    },
});

/**
 * Resolve a short-lived signed GET URL for a user's avatar. Modelled as a
 * query because the result is HMAC-derived from the key and the bucket is
 * never written to — the `ReadOnlyStorage` projection on `QueryCtx` is
 * sufficient.
 */
export const getAvatar = query({
    args: {},
    handler: async (context): Promise<{ url: string }> => {
        // Resolve the *caller's* avatar — the same `auth.userId` scoping
        // `uploadAvatar` writes under, so a signed GET round-trips to the object
        // that was just uploaded.
        const userId = context.auth.userId ?? "anonymous";
        const scopedKey = `avatars/${userId}/profile`;
        const url = await context.storage.getSignedUrl(scopedKey, { expiresInSeconds: 5 * 60 });

        return { url };
    },
});
