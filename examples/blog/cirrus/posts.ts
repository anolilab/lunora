import type { Id } from "@cirrus/server";
import { mutation, query, v } from "@cirrus/server";

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
        const result = await ctx.vectors.query("posts_search", { embed: embedText, input: text, topK: topK ?? 5 });

        return result.matches.map((match) => ({
            id: match.id as Id<"posts">,
            score: match.score,
            title: String(match.metadata?.title ?? ""),
        }));
    },
});

/**
 * Issue a short-lived PUT signed URL so the browser can stream the post's
 * featured image straight to R2 — the Worker never touches the bytes.
 */
export const requestImageUpload = mutation({
    args: { contentType: v.string() },
    handler: async (ctx, { contentType }): Promise<{ key: string; url: string }> => {
        const userId = ctx.auth.userId ?? "anonymous";
        const key = `posts/${userId}/${crypto.randomUUID()}`;
        const url = await ctx.storage.getSignedUrl(key, { expiresInSeconds: 60 });

        void contentType;

        return { key, url };
    },
});

/**
 * Publish a post. Requires an authenticated session — `ctx.auth.userId` is
 * resolved from the `@cirrus/auth` cookie/token by the runtime.
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
