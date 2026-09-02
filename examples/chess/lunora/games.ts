import { LunoraError } from "@lunora/errors";
import { rateLimit } from "lunorash/ratelimit";

import {
    applyMove,
    createInitialState,
    deserializeState,
    getGameResult,
    getMoveNotation,
    isSquareName,
    isValidMove,
    nameToSquare,
    serializeState,
} from "./chess.js";
import type { PieceType } from "./chess.js";
import { ratingUpdates } from "./players.js";
import { makeRateLimiter } from "./ratelimit/schema.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

/** Signed-in app, so limits key on the player rather than the IP. */
const mutationLimiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byPlayer = { key: (ctx: { auth: { userId?: string | null }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

const PROMOTION_CHOICES = new Set<PieceType>(["Q", "R", "B", "N"]);

export const get = query
    .input({ gameId: v.id("games") })
    .query(async ({ args: { gameId }, ctx }): Promise<Doc<"games"> | null> => (await ctx.db.get(gameId)) ?? null);

/** The move list, oldest first — the board's history panel subscribes to this. */
export const moves = query.input({ gameId: v.id("games") }).query(async ({ args: { gameId }, ctx }): Promise<Doc<"moves">[]> =>
    ctx.db
        .query("moves")
        .withIndex("by_game_turn", (q) => q.eq("gameId", gameId))
        .order("asc")
        .collect(),
);

/** Games in progress. Anyone signed in may subscribe to one and watch it move — that is all spectating is. */
export const listActive = query.query(async ({ ctx }): Promise<Doc<"games">[]> =>
    ctx.db
        .query("games")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect(),
);

export const mine = query.query(async ({ ctx }): Promise<Doc<"games">[]> => {
    if (!ctx.auth.userId) {
        return [];
    }

    const userId = ctx.auth.userId;
    const asWhite = await ctx.db
        .query("games")
        .withIndex("by_white", (q) => q.eq("whiteId", userId))
        .collect();
    const asBlack = await ctx.db
        .query("games")
        .withIndex("by_black", (q) => q.eq("blackId", userId))
        .collect();

    return [...asWhite, ...asBlack].sort((a, b) => b.startedAt - a.startedAt);
});

/** Host starts play. Host takes white. */
export const start = mutation
    .use(rateLimit(mutationLimiter, "move", byPlayer))
    .input({ lobbyId: v.id("lobbies") })
    .mutation(async ({ args: { lobbyId }, ctx }): Promise<Id<"games">> => {
        const lobby = await ctx.db.get(lobbyId);

        if (!lobby) {
            throw new LunoraError("NOT_FOUND", "lobby not found");
        }

        if (lobby.hostId !== ctx.auth.userId) {
            throw new LunoraError("UNAUTHORIZED", "only the host can start the game");
        }

        if (!lobby.guestId) {
            throw new LunoraError("CONFLICT", "waiting for an opponent");
        }

        // Without this, a second `start` on the same lobby mints a second game and
        // repoints the lobby at it: the first stays `active` forever in
        // `listActive`, and both can be played out and settle Elo for the same pair.
        // The UI hides the button once a game exists, which is exactly why this has
        // to be enforced here rather than there.
        if (lobby.gameId) {
            throw new LunoraError("CONFLICT", "this lobby already started a game");
        }

        const gameId = await ctx.db.insert("games", {
            blackId: lobby.guestId,
            moveCount: 0,
            position: serializeState(createInitialState()),
            startedAt: Date.now(),
            status: "active",
            whiteId: lobby.hostId,
        });

        ctx.log.info("game started", { black: lobby.guestId, gameId, white: lobby.hostId });

        // The guest is subscribed to the lobby, so writing the id here is how they
        // learn the game exists — no polling, no second channel.
        await ctx.db.patch(lobbyId, { gameId, isOpen: false });

        return gameId;
    });

/**
 * Play a move.
 *
 * Everything that decides the outcome happens here, from the position the shard
 * already holds: whose turn it is, whether the move is legal, what it captures,
 * whether it ends the game, and what that does to both ratings. The client runs
 * the same engine to draw legal-move dots, but its opinion never reaches the
 * database — a tampered client just gets `BAD_REQUEST`.
 *
 * The shard runs mutations one at a time, so "read position → validate → write
 * position, move row, and both profiles" is a single serialized commit. Two
 * players cannot both move against the same position.
 */
export const makeMove = mutation
    .use(rateLimit(mutationLimiter, "move", byPlayer))
    .input({
        gameId: v.id("games"),
        from: v.string().max(2),
        to: v.string().max(2),
        promotion: v.optional(v.string().max(1)),
    })
    .mutation(async ({ args: { from, gameId, promotion, to }, ctx }): Promise<{ finished: boolean }> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to play");
        }

        const game = await ctx.db.get(gameId);

        if (!game) {
            throw new LunoraError("NOT_FOUND", "game not found");
        }

        if (game.status !== "active") {
            throw new LunoraError("CONFLICT", "this game is over");
        }

        const color = ctx.auth.userId === game.whiteId ? "white" : ctx.auth.userId === game.blackId ? "black" : null;

        if (!color) {
            throw new LunoraError("UNAUTHORIZED", "you are not playing in this game");
        }

        if (!isSquareName(from) || !isSquareName(to)) {
            throw new LunoraError("BAD_REQUEST", 'squares must look like "e2"');
        }

        if (promotion !== undefined && !PROMOTION_CHOICES.has(promotion as PieceType)) {
            throw new LunoraError("BAD_REQUEST", "a pawn may only promote to Q, R, B or N");
        }

        const position = deserializeState(game.position);

        if (position.currentTurn !== color) {
            throw new LunoraError("CONFLICT", "not your turn");
        }

        const move = { from: nameToSquare(from), promotion: promotion as PieceType | undefined, to: nameToSquare(to) };

        // The load-bearing line. Without it the handler happily applies whatever
        // the client asked for — `applyMove` moves pieces, it does not judge
        // them — and a knight teleports across the board. The browser's
        // legal-move highlighting is a convenience; this is the rule.
        if (!isValidMove(position, move)) {
            throw new LunoraError("BAD_REQUEST", `illegal move: ${from}${to}`);
        }

        const captured = position.board[move.to.row][move.to.col];
        // Notation has to be read off the position *before* the move.
        const notation = getMoveNotation(position, move);
        const next = applyMove(position, move);
        const result = getGameResult(next);

        await ctx.db.insert("moves", {
            captured: captured ? `${captured.color}_${captured.type}` : undefined,
            from,
            gameId,
            notation,
            playerId: ctx.auth.userId,
            special: next.isCheckmate ? "checkmate" : next.isStalemate ? "stalemate" : next.isCheck ? "check" : undefined,
            to,
            turnNumber: game.moveCount + 1,
        });

        // `patch` rejects an explicit `undefined` — it would delete the column
        // rather than leave it alone — so the end-of-game fields are spread in
        // only when the game actually ended. `drawOfferedBy` is set to `null`
        // because a move always withdraws a pending offer.
        await ctx.db.patch(gameId, {
            drawOfferedBy: null,
            moveCount: game.moveCount + 1,
            position: serializeState(next),
            status: result ? "completed" : "active",
            ...(result ? { endedAt: Date.now(), result } : {}),
            ...(result === "white_wins" ? { winnerId: game.whiteId } : {}),
            ...(result === "black_wins" ? { winnerId: game.blackId } : {}),
        });

        ctx.log.info("move played", { gameId, notation, result: result ?? "in-progress", turn: game.moveCount + 1 });

        if (result) {
            await settle(ctx, game, result);
        }

        return { finished: Boolean(result) };
    });

/**
 * Load a game the caller is actually playing in, or refuse. The three
 * game-action mutations below all need the same pair of checks, and a guard
 * that is copied is a guard that eventually diverges.
 */
const requirePlayer = async (ctx: MutationCtx, gameId: Id<"games">): Promise<Doc<"games">> => {
    const game = await ctx.db.get(gameId);

    if (!game || game.status !== "active") {
        throw new LunoraError("CONFLICT", "this game is not in progress");
    }

    if (ctx.auth.userId !== game.whiteId && ctx.auth.userId !== game.blackId) {
        throw new LunoraError("UNAUTHORIZED", "you are not playing in this game");
    }

    return game;
};

/** Apply a finished game's result to both profiles, in the same transaction that finished it. */
const settle = async (ctx: MutationCtx, game: Doc<"games">, result: "black_wins" | "draw" | "white_wins"): Promise<void> => {
    const profileOf = async (userId: string): Promise<Doc<"profiles"> | null> =>
        ctx.db
            .query("profiles")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .first();

    const white = await profileOf(game.whiteId);
    const black = await profileOf(game.blackId);

    if (!white || !black) {
        return;
    }

    const updates = ratingUpdates(white, black, result);

    await ctx.db.patch(white._id, updates.white);
    await ctx.db.patch(black._id, updates.black);
};

export const resign = mutation
    .use(rateLimit(mutationLimiter, "move", byPlayer))
    .input({ gameId: v.id("games") })
    .mutation(async ({ args: { gameId }, ctx }): Promise<void> => {
        const game = await requirePlayer(ctx, gameId);

        const result = ctx.auth.userId === game.whiteId ? "black_wins" : "white_wins";

        await ctx.db.patch(gameId, {
            drawOfferedBy: null,
            endedAt: Date.now(),
            result,
            status: "completed",
            winnerId: result === "white_wins" ? game.whiteId : game.blackId,
        });

        ctx.log.info("game resigned", { by: ctx.auth.userId, gameId, result });
        await settle(ctx, game, result);
    });

export const offerDraw = mutation
    .use(rateLimit(mutationLimiter, "move", byPlayer))
    .input({ gameId: v.id("games") })
    .mutation(async ({ args: { gameId }, ctx }): Promise<void> => {
        await requirePlayer(ctx, gameId);

        ctx.log.info("draw offered", { by: ctx.auth.userId, gameId });
        await ctx.db.patch(gameId, { drawOfferedBy: ctx.auth.userId });
    });

export const respondToDraw = mutation
    .use(rateLimit(mutationLimiter, "move", byPlayer))
    .input({ gameId: v.id("games"), accept: v.boolean() })
    .mutation(async ({ args: { accept, gameId }, ctx }): Promise<void> => {
        const game = await requirePlayer(ctx, gameId);

        if (!game.drawOfferedBy || game.drawOfferedBy === ctx.auth.userId) {
            throw new LunoraError("CONFLICT", "there is no draw offer for you to answer");
        }

        if (!accept) {
            ctx.log.info("draw declined", { gameId });
            await ctx.db.patch(gameId, { drawOfferedBy: null });

            return;
        }

        ctx.log.info("draw accepted", { gameId });
        await ctx.db.patch(gameId, { drawOfferedBy: null, endedAt: Date.now(), result: "draw", status: "completed" });
        await settle(ctx, game, "draw");
    });
