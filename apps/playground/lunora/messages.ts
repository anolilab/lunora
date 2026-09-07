import type { RateLimitConfigMap } from "@lunora/ratelimit";
import { dbRateLimit } from "@lunora/ratelimit";

// eslint-disable-next-line unicorn/prevent-abbreviations -- "Doc" is the generated dataModel type name; aliasing it breaks codegen
import type { Doc } from "./_generated/dataModel.js";
import type { Id } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

// Named-limit config map. DB-backed (createDbStore) so the bucket is durable on
// the channel shard DO — 30 sends per minute per user.
const limits = { send: { kind: "token bucket", period: 60_000, rate: 30 } } satisfies RateLimitConfigMap;

/**
 * List recent messages for a channel. The `shardBy("channelId")` on the
 * schema means the runtime routes this query to exactly the channel's DO —
 * no fan-out, full real-time subscriptions.
 */
export const list = query.input({ channelId: v.id("channels"), limit: v.optional(v.number()) }).query(async ({ args, ctx }): Promise<Doc<"messages">[]> =>
    ctx.db
        .query("messages")
        .withIndex("by_channel_created", (q) => q.eq("channelId", args.channelId))
        .take(args.limit ?? 50),
);

/**
 * Send a message into a channel. Broadcasts a delta to every subscriber on
 * the channel's shard via `ShardDO.broadcastDelta`.
 *
 * Accepts an optional client-generated `id` (a UUID). The TanStack DB client
 * (`apps/playground/src/client`) keys its optimistic row by this id, so the
 * persisted server row must carry the *same* id for the sync engine to supersede
 * the optimistic entry on ack (per-row key match). Forwarded to `insert` as the
 * validated `clientId`; without it Lunora mints a fresh server id as usual.
 *
 * `createdAt` is taken as an arg rather than read from `Date.now()` here — a
 * mutation handler must be deterministic, so the caller stamps the timestamp
 * (the client's optimistic row, or the welcome workflow's step). Forwarding the
 * client's own value also makes the optimistic and persisted rows agree on it.
 *
 * `.use(rateLimit(...))` caps abusive senders before the write runs.
 */
export const send = mutation
    .input({
        channelId: v.id("channels"),
        createdAt: v.number(),
        id: v.optional(v.string().max(64)),
        text: v.string().max(4096),
    })
    // Rate-limit per user, falling back to the caller's IP (`ctx.ip`, sourced
    // from Cloudflare's trusted CF-Connecting-IP) for unauthenticated traffic so
    // a single anonymous client can't exhaust a shared bucket for everyone. The
    // final `"anonymous"` literal only applies when neither is known (e.g. local
    // dev without an IP).
    .use(dbRateLimit(limits, "send", { key: (context) => context.auth.userId ?? context.ip ?? "anonymous" }))
    .mutation(async ({ args, ctx }): Promise<Id<"messages">> => {
        const { channelId, createdAt, id, text } = args;

        const messageId = await ctx.db.insert(
            "messages",
            {
                channelId,
                createdAt,
                text,
                userId: ctx.auth.userId ?? "anonymous",
            },
            id ? { clientId: id } : undefined,
        );

        // After the insert: "sent" has to mean the row landed. Shape and size
        // only — the text is user content and the author is an identity.
        ctx.log.info("message sent", { channelId, characters: text.length });

        return messageId;
    });
