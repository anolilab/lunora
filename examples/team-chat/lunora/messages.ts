import { LunoraError } from "@lunora/errors";
import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
import { action, mutation, query, v } from "./_generated/server.js";

/**
 * Everyone here is signed in, so limits are keyed by user rather than by IP —
 * one person on a shared network must not be able to exhaust another's budget.
 */
const actionLimiter = (ctx: ActionCtx) => makeRateLimiter(ctx);
const mutationLimiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byUser = { key: (ctx: { auth: { userId?: string | null }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

const ATTACHMENT_TTL_SECONDS = 3600;

/** Uploads are limited to formats the chat renders or offers as a download, so nobody can stage active content in the bucket. */
const ALLOWED_ATTACHMENT_TYPES = new Set(["application/pdf", "image/avif", "image/gif", "image/jpeg", "image/png", "image/webp", "text/plain"]);

/**
 * Attachment keys this channel will vouch for.
 *
 * `requestAttachmentUpload` mints exactly this shape, so requiring it in `send`
 * is what stops a caller from attaching a key they did not upload — another
 * channel's file, or somebody else's avatar — and having the server hand out a
 * download URL for it.
 */
const attachmentKeyFor = (channelId: string, userId: string): string => `files/channels/${channelId}/${userId}/`;

/**
 * The channel's history, oldest first.
 *
 * The client passes `channelId` as the shard key, so this runs inside that
 * channel's Durable Object against its own SQLite — no fan-out, no cross-shard
 * read. Author display names are deliberately absent: `profiles` is `.global()`
 * and lives in D1, so the client joins them from its own subscription.
 *
 * Attachment *keys* come back, never signed URLs. A signed URL carries an expiry
 * and a fresh HMAC, so it is different on every evaluation — and a live query
 * whose result changes every time it re-runs defeats the shard's push
 * suppression, turning every unrelated write into a full re-send to every
 * subscriber. Everything a query returns must be a function of the data;
 * `attachmentUrl` below mints the URL on demand instead.
 */
export const list = query.input({ channelId: v.string().max(128) }).query(async ({ args: { channelId }, ctx }): Promise<Doc<"messages">[]> => {
    if (!ctx.auth.userId) {
        return [];
    }

    return ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channelId", channelId))
        .order("asc")
        .collect();
});

/**
 * Full-text search within one channel, through the `search_content` index.
 * Scoped to a channel because the index lives in that channel's shard —
 * searching everywhere would be a fan-out across every channel DO.
 */
export const search = query
    .input({ channelId: v.string().max(128), text: v.string().max(200) })
    .query(async ({ args: { channelId, text }, ctx }): Promise<Doc<"messages">[]> => {
        if (!ctx.auth.userId || !text.trim()) {
            return [];
        }

        return ctx.db
            .query("messages")
            .withSearchIndex("search_content", (q) => q.search("content", text.slice(0, 200)).eq("channelId", channelId))
            .take(20);
    });

/**
 * A short-lived download URL for one attachment.
 *
 * An action, not a query: the URL is time-varying, so it must not live in a
 * subscription's result. The client calls this when it renders a message that
 * has an attachment.
 */
export const attachmentUrl = action
    .use(rateLimit(actionLimiter, "upload", byUser))
    .input({ channelId: v.string().max(128), key: v.string().max(512) })
    .action(async ({ args: { channelId, key }, ctx }): Promise<string> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to download");
        }

        // Only keys this channel could have produced. Without the prefix check
        // the action is an oracle for any object in the bucket.
        if (!key.startsWith(`files/channels/${channelId}/`)) {
            throw new LunoraError("BAD_REQUEST", "that key does not belong to this channel");
        }

        ctx.log.info("attachment url requested", { channelId });

        try {
            return await ctx.storage.getSignedUrl(key, { expiresInSeconds: ATTACHMENT_TTL_SECONDS });
        } catch (error) {
            throw new LunoraError("INTERNAL", "could not sign a download URL: object storage did not answer", { cause: error });
        }
    });

export const send = mutation
    .use(rateLimit(mutationLimiter, "send", byUser))
    .input({
        channelId: v.string().max(128),
        content: v.string().max(4096),
        attachmentKey: v.optional(v.string().max(512)),
        attachmentName: v.optional(v.string().max(256)),
    })
    .mutation(async ({ args: { attachmentKey, attachmentName, channelId, content }, ctx }): Promise<Id<"messages">> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to post");
        }

        if (!content.trim() && !attachmentKey) {
            throw new LunoraError("BAD_REQUEST", "a message needs text or an attachment");
        }

        // The key is a client-supplied object reference, so it is checked rather
        // than trusted: it must be one this caller uploaded to this channel.
        if (attachmentKey !== undefined && !attachmentKey.startsWith(attachmentKeyFor(channelId, ctx.auth.userId))) {
            throw new LunoraError("BAD_REQUEST", "attachment key does not belong to this caller and channel");
        }

        const id = await ctx.db.insert("messages", { attachmentKey, attachmentName, authorId: ctx.auth.userId, channelId, content });

        ctx.log.info("message sent", { attachment: attachmentKey !== undefined, channelId, id });

        return id;
    });

/**
 * Mint a signed PUT URL so the browser streams the file straight into R2 — the
 * Worker never sees the bytes. Write-side storage is an action-only capability;
 * queries and mutations get the read-only surface.
 *
 * The content type is pinned into the signature here, and the `/files/*` route
 * stores *that* value rather than whatever the upload request claims — otherwise
 * this allowlist would only gate the mint, not the object.
 */
export const requestAttachmentUpload = action
    .use(rateLimit(actionLimiter, "upload", byUser))
    .input({ channelId: v.string().max(128), contentType: v.string().max(128) })
    .action(async ({ args: { channelId, contentType }, ctx }): Promise<{ key: string; url: string }> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to upload");
        }

        if (!ALLOWED_ATTACHMENT_TYPES.has(contentType)) {
            throw new LunoraError("BAD_REQUEST", `unsupported attachment type: ${contentType}`);
        }

        // Keyed under `files/` so the worker's signed-asset route matches, and
        // under the uploader's id so nobody can overwrite someone else's object.
        const key = `${attachmentKeyFor(channelId, ctx.auth.userId)}${crypto.randomUUID()}`;

        ctx.log.info("upload url requested", { channelId, contentType });

        try {
            return { key, url: await ctx.storage.generateUploadUrl(key, { contentType, expiresInSeconds: 60 }) };
        } catch (error) {
            throw new LunoraError("INTERNAL", "could not sign an upload URL: object storage did not answer", { cause: error });
        }
    });
