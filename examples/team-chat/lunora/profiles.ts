import { LunoraError } from "@lunora/errors";
import { rateLimit } from "lunorash/ratelimit";

import type { Doc as Document_, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
import { action, mutation, query, v } from "./_generated/server.js";
import { makeRateLimiter } from "./ratelimit/schema.js";

/** Signed-in app, so limits key on the user rather than the IP. */
const actionLimiter = (ctx: ActionCtx) => makeRateLimiter(ctx);
const mutationLimiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byUser = { key: (ctx: { auth: { userId?: string | null }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

const AVATAR_TTL_SECONDS = 3600;
const ALLOWED_AVATAR_TYPES = new Set(["image/avif", "image/jpeg", "image/png", "image/webp"]);

/**
 * The one object key a given user's avatar may ever occupy.
 *
 * Every handler below derives the key through this rather than accepting one,
 * so "which object does this call touch" is answered by the resolved session
 * and a table lookup, never by a string the caller typed. `requestAvatarUpload`
 * mints it, `save` refuses anything else, and `avatarUrl` signs it — one
 * definition, three call sites, no room for them to disagree.
 */
const avatarKeyFor = (userId: string): string => `files/avatars/${userId}`;

/**
 * The member directory.
 *
 * Note the shape of these reads. `profiles` is `.global()`, so it lives in D1
 * rather than in a shard's SQLite — and the D1 backend does not serve the
 * `ctx.db.query(...).withIndex(...)` reader at all. `.global()` tables are read
 * through the per-table facade (`ctx.db.profiles.findMany` / `findFirst`),
 * which compiles to SQL. Reach for the legacy reader on a global table and it
 * throws at runtime with types that compiled cleanly.
 *
 * This is the one query that resolves display names for messages written in any
 * channel shard. The client subscribes once and joins locally.
 *
 * Avatar *keys* come back, not signed URLs — see the note on `messages.list`.
 * Every client subscribes to this query, so a per-evaluation URL here would
 * re-push the whole directory to everyone on every unrelated write.
 */
export const list = query.query(async ({ ctx }): Promise<Document_<"profiles">[]> => {
    if (!ctx.auth.userId) {
        return [];
    }

    const { page } = await ctx.db.profiles.findMany({});

    return page;
});

/**
 * A short-lived URL for one member's avatar. An action for the same reason as
 * `messages.attachmentUrl`.
 *
 * It takes the member's `userId` — which the directory hands out — and derives
 * the key, instead of accepting a key and checking its prefix. The prefix check
 * bounded the namespace but not the identity: `files/avatars/<anyone>` passed
 * it, and so would any other object that ever lands under that prefix. Deriving
 * the key removes the choice rather than narrowing it, and the `by_user` lookup
 * means an id nobody has a profile for signs nothing at all.
 */
export const avatarUrl = action
    .use(rateLimit(actionLimiter, "upload", byUser))
    .input({ userId: v.string().max(128) })
    .action(async ({ args: { userId }, ctx }): Promise<string> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to view avatars");
        }

        const profile = await ctx.db.profiles.findFirst({ where: { userId } });

        if (!profile?.avatarKey) {
            throw new LunoraError("NOT_FOUND", "that member has no avatar");
        }

        ctx.log.info("avatar url requested", {});

        try {
            return await ctx.storage.getSignedUrl(avatarKeyFor(userId), { expiresInSeconds: AVATAR_TTL_SECONDS });
        } catch (error) {
            throw new LunoraError("INTERNAL", "could not sign an avatar URL: object storage did not answer", { cause: error });
        }
    });

/**
 * Create or update the signed-in user's own profile.
 *
 * `upsert` resolves against the unique `userId` column in one call, so two tabs
 * signing in at once cannot race a read-then-insert into a duplicate — the
 * conflict target and the uniqueness guarantee are the same thing.
 */
export const save = mutation
    .use(rateLimit(mutationLimiter, "send", byUser))
    .input({ name: v.string().max(80), avatarKey: v.optional(v.string().max(512)) })
    .mutation(async ({ args: { avatarKey, name }, ctx }): Promise<Id<"profiles">> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to edit your profile");
        }

        // The only key this caller could have uploaded to. Without this the
        // column is a caller-written string that later reads treat as an object
        // reference — the same hole as accepting a key outright, just stored.
        if (avatarKey !== undefined && avatarKey !== avatarKeyFor(ctx.auth.userId)) {
            throw new LunoraError("BAD_REQUEST", "that is not your avatar key");
        }

        const { id } = await ctx.db.profiles.upsert({
            create: { avatarKey, name, userId: ctx.auth.userId },
            target: "userId",
            // An avatar upload and a rename are separate calls, so only overwrite
            // the key when this call actually carries one.
            update: avatarKey === undefined ? { name } : { avatarKey, name },
        });

        ctx.log.info("profile saved", { id });

        return id;
    });

export const requestAvatarUpload = action
    .use(rateLimit(actionLimiter, "upload", byUser))
    .input({ contentType: v.string().max(128) })
    .action(async ({ args: { contentType }, ctx }): Promise<{ key: string; url: string }> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to upload");
        }

        if (!ALLOWED_AVATAR_TYPES.has(contentType)) {
            throw new LunoraError("BAD_REQUEST", `unsupported image type: ${contentType}`);
        }

        // Keyed under `files/` so the worker's signed-asset route matches the
        // URL, and under the uploader's id so nobody can overwrite another's.
        const key = avatarKeyFor(ctx.auth.userId);

        ctx.log.info("avatar upload requested", { contentType });

        try {
            return { key, url: await ctx.storage.generateUploadUrl(key, { contentType, expiresInSeconds: 60 }) };
        } catch (error) {
            throw new LunoraError("INTERNAL", "could not sign an avatar upload URL: object storage did not answer", { cause: error });
        }
    });
