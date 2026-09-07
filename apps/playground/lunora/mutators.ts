import type { RateLimitConfigMap } from "@lunora/ratelimit";
import { createDbStore, RateLimiter } from "@lunora/ratelimit";

// `defineMutator` comes from `./_generated/server` (not `lunorash/server`) so the
// authoritative `server` impl's `ctx` is this project's typed `MutationCtx` —
// `ctx.db.insert("messages", …)` checks the columns against the schema.
import { defineMutator, v } from "./_generated/server";

/**
 * Same budget as `messages.send` (30/min/caller). Both write the `messages`
 * table, so a limit on only one of them is decorative: a caller told "429" by
 * `messages:send` would just push the identical row through
 * `mutators:sendMessage` instead.
 */
const limits = { sendMessage: { kind: "token bucket", period: 60_000, rate: 30 } } satisfies RateLimitConfigMap;

/**
 * Custom mutator — the client runs `client` optimistically against its local
 * TanStack collections, the shard DO runs `server` as the authoritative
 * linearization point, and the resulting `__cdc_log` rows poke back to every
 * subscriber. The client rebase is free (TanStack re-derives pending overlays).
 *
 * SECURITY — this is publicly dispatchable (codegen registers it in
 * `LUNORA_FUNCTIONS` and exposes it on the `api` proxy), so it carries the same
 * three controls as its sibling `messages.send`:
 *
 *  - **Author identity is the server's.** `owner: "userId"` makes the runtime
 *    require a verified identity, reject a `userId` arg that disagrees with it,
 *    and overwrite the column with the verified value before `server` runs. The
 *    arg stays on the wire (the optimistic client row needs it) but is no longer
 *    trusted — without this, any signed-in caller could post as anyone else and
 *    the message would render under the spoofed author's name.
 *  - **Text is bounded** at 4096 characters, matching `messages.send`.
 *  - **Writes are rate-limited** per caller (see {@link limits}).
 */
export const sendMessage = defineMutator({
    // `createdAt` is stamped by the caller (not `Date.now()` here) so the
    // authoritative handler stays deterministic — same as `messages.send`.
    args: {
        channelId: v.id("channels"),
        createdAt: v.number(),
        text: v.string().check((value) => value.length <= 4096, { message: "must be at most 4096 characters", schema: { maxLength: 4096 } }),
        // Overwritten with the verified identity by `owner` below; a value that
        // disagrees with it is rejected rather than corrected.
        userId: v.id("users"),
    },
    client: () => {
        // Optimistic overlay is applied by the binding; nothing extra to do here.
    },
    owner: "userId",
    server: async (ctx, arguments_) => {
        // Mutators have no `.use()` chain, so the limiter is invoked inline;
        // `throws: true` raises the same `TOO_MANY_REQUESTS`/429 the `.use()`
        // middleware would. The accounting write rides this mutation's
        // transaction: a denial consumes nothing and rolls back with the throw,
        // an admitted call commits its decrement alongside the row.
        const limiter = new RateLimiter({ config: limits, store: createDbStore({ db: ctx.db }) });

        await limiter.limit("sendMessage", { key: arguments_.userId, throws: true });

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
