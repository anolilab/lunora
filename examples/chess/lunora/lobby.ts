import { LunoraError } from "@lunora/errors";

import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";

/** Ambiguous glyphs (0/O, 1/I) are left out so a code can be read aloud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const newInviteCode = (): string =>
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");

export const listOpen = query.query(async ({ ctx }): Promise<Doc<"lobbies">[]> =>
    ctx.db
        .query("lobbies")
        .withIndex("by_open_public", (q) => q.eq("isPrivate", false).eq("isOpen", true))
        .order("asc")
        .collect(),
);

/** The lobby this player is in, whether they host it or joined it. */
export const mine = query.query(async ({ ctx }): Promise<(Doc<"lobbies"> & { isHost: boolean }) | null> => {
    if (!ctx.auth.userId) {
        return null;
    }

    const userId = ctx.auth.userId;
    const hosted = await ctx.db
        .query("lobbies")
        .withIndex("by_host", (q) => q.eq("hostId", userId))
        .first();

    if (hosted) {
        return { ...hosted, isHost: true };
    }

    const joined = await ctx.db
        .query("lobbies")
        .withIndex("by_guest", (q) => q.eq("guestId", userId))
        .first();

    return joined ? { ...joined, isHost: false } : null;
});

/**
 * Open a table. `by_host` is unique, so one player can only host one lobby —
 * the check below turns that constraint into a readable error, and cleans up a
 * lobby whose game has already started.
 */
export const create = mutation.input({ isPrivate: v.boolean() }).mutation(async ({ args: { isPrivate }, ctx }): Promise<Id<"lobbies">> => {
    if (!ctx.auth.userId) {
        throw new LunoraError("UNAUTHENTICATED", "sign in to open a lobby");
    }

    const userId = ctx.auth.userId;
    const existing = await ctx.db
        .query("lobbies")
        .withIndex("by_host", (q) => q.eq("hostId", userId))
        .first();

    if (existing) {
        if (!existing.gameId) {
            throw new LunoraError("CONFLICT", "you already have a lobby open");
        }

        await ctx.db.delete(existing._id);
    }

    return ctx.db.insert("lobbies", {
        createdAt: Date.now(),
        hostId: userId,
        inviteCode: isPrivate ? newInviteCode() : undefined,
        isOpen: true,
        isPrivate,
    });
});

/** Sit down at a specific table. A private lobby additionally needs its invite code. */
export const join = mutation
    .input({ lobbyId: v.id("lobbies"), inviteCode: v.optional(v.string().meta({ schema: { maxLength: 16 } })) })
    .mutation(async ({ args: { inviteCode, lobbyId }, ctx }): Promise<void> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to join");
        }

        const lobby = await ctx.db.get(lobbyId);

        if (!lobby) {
            throw new LunoraError("NOT_FOUND", "lobby not found");
        }

        if (lobby.hostId === ctx.auth.userId || lobby.guestId === ctx.auth.userId) {
            return;
        }

        if (lobby.isPrivate && lobby.inviteCode !== inviteCode?.toUpperCase()) {
            throw new LunoraError("UNAUTHORIZED", "wrong invite code");
        }

        if (!lobby.isOpen || lobby.guestId) {
            throw new LunoraError("CONFLICT", "that lobby is full");
        }

        await ctx.db.patch(lobbyId, { guestId: ctx.auth.userId, isOpen: false });
    });

export const joinByCode = mutation
    .input({ inviteCode: v.string().meta({ schema: { maxLength: 16 } }) })
    .mutation(async ({ args: { inviteCode }, ctx }): Promise<Id<"lobbies">> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to join");
        }

        const lobby = await ctx.db
            .query("lobbies")
            .withIndex("by_invite_code", (q) => q.eq("inviteCode", inviteCode.toUpperCase()))
            .first();

        if (!lobby) {
            throw new LunoraError("NOT_FOUND", "no lobby with that code");
        }

        if (lobby.hostId !== ctx.auth.userId && lobby.guestId !== ctx.auth.userId) {
            if (!lobby.isOpen || lobby.guestId) {
                throw new LunoraError("CONFLICT", "that lobby is full");
            }

            await ctx.db.patch(lobby._id, { guestId: ctx.auth.userId, isOpen: false });
        }

        return lobby._id;
    });

/** Matchmaking: take the oldest open public seat, or open one. */
export const quickMatch = mutation.mutation(async ({ ctx }): Promise<Id<"lobbies">> => {
    if (!ctx.auth.userId) {
        throw new LunoraError("UNAUTHENTICATED", "sign in to play");
    }

    const userId = ctx.auth.userId;
    const hosted = await ctx.db
        .query("lobbies")
        .withIndex("by_host", (q) => q.eq("hostId", userId))
        .first();

    if (hosted && !hosted.gameId) {
        return hosted._id;
    }

    if (hosted) {
        await ctx.db.delete(hosted._id);
    }

    const joined = await ctx.db
        .query("lobbies")
        .withIndex("by_guest", (q) => q.eq("guestId", userId))
        .first();

    if (joined) {
        return joined._id;
    }

    const open = await ctx.db
        .query("lobbies")
        .withIndex("by_open_public", (q) => q.eq("isPrivate", false).eq("isOpen", true))
        .order("asc")
        .first();

    if (open && open.hostId !== userId) {
        await ctx.db.patch(open._id, { guestId: userId, isOpen: false });

        return open._id;
    }

    return ctx.db.insert("lobbies", { createdAt: Date.now(), hostId: userId, isOpen: true, isPrivate: false });
});

/** Stand up. The host leaving closes the table; the guest leaving reopens the seat. */
export const leave = mutation.input({ lobbyId: v.id("lobbies") }).mutation(async ({ args: { lobbyId }, ctx }): Promise<void> => {
    const lobby = await ctx.db.get(lobbyId);

    if (!lobby || !ctx.auth.userId) {
        return;
    }

    if (lobby.hostId === ctx.auth.userId) {
        await ctx.db.delete(lobbyId);

        return;
    }

    if (lobby.guestId === ctx.auth.userId) {
        // `null`, not `undefined`: `patch` refuses an explicit undefined.
        await ctx.db.patch(lobbyId, { guestId: null, isOpen: true });
    }
});
