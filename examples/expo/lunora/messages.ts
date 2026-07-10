import { LunoraError } from "lunorash/server";

import type { Id } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

interface MessageRow {
    _id: Id<"messages">;
    authorName: string;
    createdAt: number;
    text: string;
    userId: string;
}

/** How many messages the chat screen keeps live. */
const PAGE_SIZE = 100;

/**
 * `ctx.auth.userId` is populated by Lunora's runtime from the resolved
 * better-auth session — see `src/server/index.ts` for the `resolveIdentity`
 * wiring. A `null` userId means the caller is anonymous.
 */
const assertSignedIn = (userId: null | string): string => {
    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "sign in to use the chat");
    }

    return userId;
};

/**
 * The most recent messages, oldest-first (chat order). Every signed-in client
 * that calls this over the WebSocket receives deltas the instant `send` writes a
 * new row — no polling, no manual refetch.
 */
export const list = query.query(async ({ ctx }): Promise<MessageRow[]> => {
    assertSignedIn(ctx.auth.userId);

    const rows = await ctx.db.query("messages").withIndex("by_created").collect();

    // Keep the last PAGE_SIZE, chronological. `by_created` scans ascending, so
    // slice from the tail and leave it oldest-first for the UI.
    return rows.slice(-PAGE_SIZE);
});

/**
 * Post a message. `userId` is stamped from the authenticated session (never
 * trusted from the client); `authorName` is the sender's own display name.
 */
export const send = mutation
    .input({ authorName: v.string(), text: v.string() })
    .mutation(async ({ args: { authorName, text }, ctx }): Promise<Id<"messages">> => {
        const userId = assertSignedIn(ctx.auth.userId);
        const trimmed = text.trim();

        if (trimmed === "") {
            throw new LunoraError("BAD_REQUEST", "message text is empty");
        }

        return ctx.db.insert("messages", {
            authorName,
            createdAt: Date.now(),
            text: trimmed,
            userId,
        });
    });
