import type { Id } from "@lunora/server";
import { mutation, query, v } from "@lunora/server";

import { embedText } from "./embed.js";

interface PostDoc {
    _id: Id<"posts">;
    authorId: Id<"users">;
    body: string;
    imageKey?: string;
    publishedAt: number;
    title: string;
}

/**
 * Public feed — list every post, newest first. Open to anonymous readers.
 */
export const list = query({
    args: {},
    handler: async (ctx): Promise<PostDoc[]> => {
        const rows = (await ctx.db.query("posts").withIndex("by_published").collect()) as unknown as PostDoc[];

        return [...rows].sort((a, b) => b.publishedAt - a.publishedAt);
    },
});

export const get = query({
    args: { id: v.id("posts") },
    handler: async (ctx, { id }): Promise<PostDoc | null> => ((await ctx.db.get(id)) as PostDoc | null) ?? null,
});

/**
 * Semantic search over post bodies. `.vectorize("body", …)` keeps the
 * `posts_search` index in sync on every write, so here we just embed the query
 * text and ask `ctx.vectors` for the nearest posts. `title` rides along as
 * Vectorize metadata, so a result preview needs no extra DB read.
 */
export const search = query({
    args: { text: v.string(), topK: v.optional(v.number()) },
    handler: async (ctx, { text, topK }): Promise<Array<{ id: Id<"posts">; score: number; title: string }>> => {
        // Bound user-supplied inputs: clamp `topK` to a sane ceiling and cap the
        // query text length so a caller can't ask for unbounded work.
        const boundedTopK = Math.min(Math.max(topK ?? 5, 1), 50);
        const input = text.slice(0, 1000);
        const result = await ctx.vectors.query("posts_search", { embed: embedText, input, topK: boundedTopK });

        return result.matches.map((match) => ({
            id: match.id as Id<"posts">,
            score: match.score,
            title: String(match.metadata?.title ?? ""),
        }));
    },
});

/**
 * Image content types we hand out signed upload URLs for. Keeping this explicit
 * stops a caller from staging arbitrary payloads (e.g. HTML) under `posts/`.
 */
const ALLOWED_IMAGE_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

/**
 * Issue a short-lived PUT signed URL so the browser can stream the post's
 * featured image straight to R2 — the Worker never touches the bytes. Requires
 * an authenticated session, exactly like `publish`, so uploads are always bound
 * to a real user and the client-supplied content type is on the allowlist.
 */
export const requestImageUpload = mutation({
    args: { contentType: v.string() },
    handler: async (ctx, { contentType }): Promise<{ key: string; url: string }> => {
        if (!ctx.auth.userId) {
            throw new Error("not signed in");
        }

        if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
            throw new Error(`unsupported content type: ${contentType}`);
        }

        const key = `posts/${ctx.auth.userId}/${crypto.randomUUID()}`;
        const url = await ctx.storage.getSignedUrl(key, { contentType, expiresInSeconds: 60, method: "PUT" });

        return { key, url };
    },
});

/**
 * Publish a post. Requires an authenticated session — `ctx.auth.userId` is
 * resolved from the `@lunora/auth` cookie/token by the runtime.
 */
export const publish = mutation({
    args: { title: v.string(), body: v.string(), imageKey: v.optional(v.string()) },
    handler: async (ctx, { title, body, imageKey }): Promise<Id<"posts">> => {
        if (!ctx.auth.userId) {
            throw new Error("not signed in");
        }

        return ctx.db.insert("posts", {
            authorId: ctx.auth.userId as Id<"users">,
            body,
            imageKey,
            publishedAt: Date.now(),
            title,
        });
    },
});
