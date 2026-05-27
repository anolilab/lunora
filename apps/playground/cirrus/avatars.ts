import { mutation, query, v } from "@cirrus/server";

/**
 * Issue a short-lived PUT signed URL so the browser can upload an avatar
 * directly to R2 without proxying through the Worker. The key is namespaced
 * under the caller's user id so we don't collide across tenants.
 */
export const uploadAvatar = mutation({
    args: { contentType: v.string(), key: v.string() },
    handler: async (context, { contentType, key }): Promise<{ key: string; url: string }> => {
        const userId = context.auth.userId ?? "anonymous";
        const scopedKey = `avatars/${userId}/${key}`;
        const url = await context.storage.getSignedUrl(scopedKey, { expiresInSeconds: 60 });

        // contentType is forwarded by the client when invoking the PUT.
        void contentType;

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
    args: { userId: v.id("users") },
    handler: async (context, { userId }): Promise<{ url: string }> => {
        const scopedKey = `avatars/${userId}/profile`;
        const url = await context.storage.getSignedUrl(scopedKey, { expiresInSeconds: 5 * 60 });

        return { url };
    },
});
