import { defineSchema, defineTable, v } from "lunorash/server";

import { ratelimit } from "./ratelimit/schema.js";

/**
 * chess — lobbies, live games, spectators, Elo.
 *
 * Everything here is root-scoped: one ShardDO owns every game.
 *
 * That is a deliberate choice, not an oversight. A chess game is a handful of
 * writes per minute, and the single shard buys the property the game actually
 * needs: both players' moves are serialized into one order by construction. No
 * two clients can interleave a move against a stale position, because the shard
 * runs mutations one at a time against its own SQLite.
 *
 * The ceiling is roughly 1 000 requests/second for the whole server. Past that,
 * `.shardBy` a game key so each game gets its own object, and keep a small
 * root-scoped directory table for the lobby and spectator lists —
 * `examples/team-chat` shows that layout. Promote `profiles` to `.global()` at
 * the same time, since ratings then have to resolve from inside any game's
 * shard.
 */
export default defineSchema({
    profiles: defineTable({
        userId: v.string(),
        displayName: v.string(),
        rating: v.number(),
        gamesPlayed: v.number(),
        gamesWon: v.number(),
    })
        .index("by_user", ["userId"], { unique: true })
        .index("by_rating", ["rating"]),

    lobbies: defineTable({
        hostId: v.string(),
        // Nullable, not just optional: `ctx.db.patch` refuses an explicit
        // `undefined` (it would silently delete the field rather than clear it),
        // so a column that has to be *cleared* — here when a guest stands up —
        // must be able to hold `null`.
        guestId: v.optional(v.union(v.string(), v.null())),
        isPrivate: v.boolean(),
        isOpen: v.boolean(),
        inviteCode: v.optional(v.string()),
        createdAt: v.number(),
        /** Set when the host starts play, so the guest's subscription can follow along without polling. */
        gameId: v.optional(v.id("games")),
    })
        .index("by_host", ["hostId"], { unique: true })
        .index("by_guest", ["guestId"])
        .index("by_invite_code", ["inviteCode"])
        .index("by_open_public", ["isPrivate", "isOpen", "createdAt"]),

    games: defineTable({
        status: v.union(v.literal("active"), v.literal("completed"), v.literal("abandoned")),
        whiteId: v.string(),
        blackId: v.string(),
        /** The whole position as JSON — board, castling rights, en-passant target, clocks. */
        position: v.string(),
        result: v.optional(v.union(v.literal("white_wins"), v.literal("black_wins"), v.literal("draw"))),
        winnerId: v.optional(v.string()),
        moveCount: v.number(),
        startedAt: v.number(),
        endedAt: v.optional(v.number()),
        // Cleared on every move and on a draw response — nullable for the same reason as `guestId`.
        drawOfferedBy: v.optional(v.union(v.string(), v.null())),
    })
        .index("by_status", ["status"])
        .index("by_white", ["whiteId"])
        .index("by_black", ["blackId"]),

    moves: defineTable({
        gameId: v.id("games"),
        playerId: v.string(),
        turnNumber: v.number(),
        notation: v.string(),
        from: v.string(),
        to: v.string(),
        captured: v.optional(v.string()),
        special: v.optional(v.string()),
    }).index("by_game_turn", ["gameId", "turnNumber"], { unique: true }),
}).extend(ratelimit.extension);
