import { LunoraError } from "@lunora/errors";
import { rateLimit } from "lunorash/ratelimit";

import { makeRateLimiter } from "./ratelimit/schema.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

/** Signed-in app, so limits key on the player rather than the IP. */
const mutationLimiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byPlayer = { key: (ctx: { auth: { userId?: string | null }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

/** Standard Elo K-factor, and the floor a rating cannot drop below. */
const K_FACTOR = 32;
const RATING_FLOOR = 100;
const STARTING_RATING = 1200;

export const me = query.query(async ({ ctx }): Promise<Doc<"profiles"> | null> => {
    if (!ctx.auth.userId) {
        return null;
    }

    const userId = ctx.auth.userId;

    return ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();
});

/** Every player, for resolving display names next to a board. Small by construction in a demo. */
export const list = query.query(async ({ ctx }): Promise<Doc<"profiles">[]> => ctx.db.query("profiles").collect());

export const leaderboard = query.query(async ({ ctx }): Promise<Doc<"profiles">[]> => ctx.db.query("profiles").withIndex("by_rating").order("desc").take(20));

/**
 * Create this account's profile if it has none. `by_user` is unique, so two
 * tabs racing on first sign-in cannot produce two profiles.
 */
export const claim = mutation
    .use(rateLimit(mutationLimiter, "write", byPlayer))
    .input({ displayName: v.optional(v.string().max(80)) })
    .mutation(async ({ args: { displayName }, ctx }): Promise<void> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in first");
        }

        const userId = ctx.auth.userId;
        const existing = await ctx.db
            .query("profiles")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .first();

        if (existing) {
            if (displayName && displayName !== existing.displayName) {
                await ctx.db.patch(existing._id, { displayName });
            }

            return;
        }

        ctx.log.info("profile claimed", { userId });
        await ctx.db.insert("profiles", {
            displayName: displayName ?? `Player ${ctx.auth.userId.slice(0, 4)}`,
            gamesPlayed: 0,
            gamesWon: 0,
            rating: STARTING_RATING,
            userId: ctx.auth.userId,
        });
    });

/** The expected score for `rating` against `against`, i.e. the Elo logistic curve. */
const expectedScore = (rating: number, against: number): number => 1 / (1 + 10 ** ((against - rating) / 400));

/**
 * The fields a finished game changes on one player's profile. A type alias
 * rather than an interface, so it still satisfies `ctx.db.patch`'s
 * `Record<string, unknown>` — an interface has no index signature.
 */
export type RatingUpdate = {
    gamesPlayed: number;
    gamesWon: number;
    rating: number;
};

/**
 * Both players' post-game profile fields.
 *
 * A pure function, deliberately: `games.makeMove` and `games.resign` apply the
 * result inside the same shard transaction that ends the game, so a crash can
 * never leave a finished game with unadjusted ratings. Routing this through a
 * second mutation would open exactly that window — and this way the arithmetic
 * is testable without a database.
 */
export const ratingUpdates = (
    white: Doc<"profiles">,
    black: Doc<"profiles">,
    result: "black_wins" | "draw" | "white_wins",
): { black: RatingUpdate; white: RatingUpdate } => {
    const whiteScore = result === "white_wins" ? 1 : result === "draw" ? 0.5 : 0;

    return {
        black: {
            gamesPlayed: black.gamesPlayed + 1,
            gamesWon: black.gamesWon + (result === "black_wins" ? 1 : 0),
            rating: Math.max(RATING_FLOOR, Math.round(black.rating + K_FACTOR * (1 - whiteScore - expectedScore(black.rating, white.rating)))),
        },
        white: {
            gamesPlayed: white.gamesPlayed + 1,
            gamesWon: white.gamesWon + (result === "white_wins" ? 1 : 0),
            rating: Math.max(RATING_FLOOR, Math.round(white.rating + K_FACTOR * (whiteScore - expectedScore(white.rating, black.rating)))),
        },
    };
};
