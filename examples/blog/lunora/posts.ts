import { LunoraError } from "lunorash/server";
import { rateLimit } from "lunorash/ratelimit";

import { embedText } from "./embed.js";
import { makeRateLimiter } from "./ratelimit/schema.js";
import type { ActionCtx, Id, MutationCtx } from "./_generated/server.js";
import { action, mutation, query, v } from "./_generated/server.js";

/**
 * One limiter per context kind: a middleware's context type flows into the
 * handler, so a single limiter typed loosely enough for both would erase
 * `ctx.storage` on the action and `ctx.db` on the mutation.
 */
const actionLimiter = (ctx: ActionCtx) => makeRateLimiter(ctx);
const mutationLimiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byUser = { key: (ctx: { auth: { userId?: null | string }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

interface PostDoc {
    _id: Id<"posts">;
    authorId: string;
    body: string;
    imageKey?: string;
    publishedAt: number;
    title: string;
}

/**
 * Public feed — list every post, newest first. Open to anonymous readers.
 */
export const list = query.query(async ({ ctx }): Promise<PostDoc[]> =>
    // `.order("desc")` on the `by_published` index — the database does the
    // ordering, so this stays right (and cheap) as the feed grows.
    ctx.db.query("posts").withIndex("by_published").order("desc").collect(),
);

export const get = query.input({ id: v.id("posts") }).query(async ({ args: { id }, ctx }): Promise<PostDoc | null> => (await ctx.db.get(id)) ?? null);

/**
 * Semantic search over post bodies. `.vectorize("body", …)` keeps the
 * `posts_search` index in sync on every write, so here we just embed the query
 * text and ask `ctx.vectors` for the nearest posts. `title` rides along as
 * Vectorize metadata, so a result preview needs no extra DB read.
 */
export const search = query
    .input({ text: v.string().max(1000), topK: v.optional(v.number()) })
    .query(async ({ args: { text, topK }, ctx }): Promise<Array<{ id: Id<"posts">; score: number; title: string }>> => {
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
export const requestImageUpload = action
    .input({ contentType: v.string().max(128) })
    .use(rateLimit(actionLimiter, "upload", byUser))
    .action(async ({ args: { contentType }, ctx }): Promise<{ key: string; url: string }> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHORIZED", "sign in to upload an image");
        }

        if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
            throw new LunoraError("BAD_REQUEST", `unsupported content type: ${contentType}`);
        }

        // Minting a PUT upload URL is a write-side storage capability, so this is
        // an `action` (queries/mutations only get the read-only storage surface).
        const key = `posts/${ctx.auth.userId}/${crypto.randomUUID()}`;

        try {
            const url = await ctx.storage.generateUploadUrl(key, { contentType, expiresInSeconds: 60 });

            return { key, url };
        } catch (error) {
            // Signing fails loudly when `STORAGE_SECRET` / `PUBLIC_STORAGE_BASE_URL`
            // are missing (see `.dev.vars.example`). Naming the dependency here
            // beats the caller receiving a bare 500.
            throw new LunoraError("INTERNAL", "could not mint an R2 upload URL", { cause: error });
        }
    });

/**
 * Publish a post. Requires an authenticated session — `ctx.auth.userId` is
 * resolved from the `@lunora/auth` cookie/token by the runtime.
 */
export const publish = mutation
    .input({
        title: v.string().max(256),
        body: v.string().max(100_000),
        imageKey: v.optional(v.string().max(512)),
    })
    .use(rateLimit(mutationLimiter, "write", byUser))
    .mutation(async ({ args: { title, body, imageKey }, ctx }): Promise<Id<"posts">> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHORIZED", "sign in to publish");
        }

        return ctx.db.insert("posts", {
            authorId: ctx.auth.userId,
            body,
            imageKey,
            publishedAt: Date.now(),
            title,
        });
    });
