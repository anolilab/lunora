// `defineMutator` comes from `./_generated/server` (not `lunorash/server`) so the
// authoritative `server` impl's `ctx` is this project's typed `MutationCtx` —
// `ctx.db.insert("messages", …)` checks the columns against the schema.
import { defineMutator, v } from "./_generated/server";

/**
 * Custom mutator — the client runs `client` optimistically against its local
 * TanStack collections, the shard DO runs `server` as the authoritative
 * linearization point, and the resulting `__cdc_log` rows poke back to every
 * subscriber. The client rebase is free (TanStack re-derives pending overlays).
 */
export const sendMessage = defineMutator({
    // `createdAt` is stamped by the caller (not `Date.now()` here) so the
    // authoritative handler stays deterministic — same as `messages.send`.
    args: { channelId: v.id("channels"), createdAt: v.number(), text: v.string(), userId: v.id("users") },
    client: () => {
        // Optimistic overlay is applied by the binding; nothing extra to do here.
    },
    server: async (ctx, arguments_) => {
        // Persist the authoritative row so it appends to `__cdc_log` and pokes
        // every `channelMessages` subscriber. Echoing the args alone would emit
        // no CDC entry, so subscribers would never observe the send.
        const id = await ctx.db.insert("messages", {
            channelId: arguments_.channelId,
            createdAt: arguments_.createdAt,
            text: arguments_.text,
            userId: arguments_.userId,
        });

        return { _id: id, channelId: arguments_.channelId, text: arguments_.text };
    },
});
