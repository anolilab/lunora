import { LunoraError } from "lunorash/server";

import type { Id } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

interface MessageDoc {
    _id: Id<"messages">;
    author: string;
    createdAt: number;
    text: string;
}

/**
 * List messages newest-first. Subscribers receive deltas the moment `send`
 * commits a new row.
 */
export const list = query.query(async ({ ctx }): Promise<MessageDoc[]> => {
    const rows = await ctx.db.query("messages").withIndex("by_creation").collect();

    return [...rows].sort((a, b) => b.createdAt - a.createdAt);
});

/**
 * Persist a message — but reject some inputs *deterministically* so the demo can
 * reproduce a rejected optimistic write on demand:
 *
 * - any message containing the word "fail" → a coded `CONFLICT`,
 * - an empty message → a coded `BAD_REQUEST`.
 *
 * Throwing a {@link LunoraError} yields a coded `{ error: { code, message } }`
 * envelope; the client treats a *coded* rejection as a terminal verdict (it
 * drops the queued write rather than retrying) and surfaces it on
 * `onMutationSettled` / the rejected `mutation()` Promise.
 */
export const send = mutation
    .input({ text: v.string().max(4096), author: v.string().max(80) })
    .mutation(async ({ args: { text, author }, ctx }): Promise<Id<"messages">> => {
        const trimmed = text.trim();

        if (trimmed === "") {
            throw new LunoraError("BAD_REQUEST", "message text cannot be empty");
        }

        if (/\bfail\b/i.test(trimmed)) {
            throw new LunoraError("CONFLICT", `the server refused to save "${trimmed}"`);
        }

        return ctx.db.insert("messages", { text: trimmed, author, createdAt: Date.now() });
    });
