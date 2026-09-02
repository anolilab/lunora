import { rateLimit } from "lunorash/ratelimit";

import { midpoint } from "./ordering.js";
import { makeRateLimiter } from "./ratelimit/schema.js";
import type { Doc } from "./_generated/dataModel.js";
import type { Id, MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

type Status = Doc<"tasks">["status"];

/**
 * Every write here is unauthenticated — this demo has no sign-in — so the only
 * thing standing between a deployed board and a script is a limit. Keyed by
 * caller IP, since there is no user to key on.
 *
 * `ratelimit_buckets` is durable and lives in this shard, so the counter is the
 * same one every request sees rather than per-isolate memory.
 */
const limiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byCaller = { key: (ctx: MutationCtx): string => ctx.ip ?? "anon" };

/** Cards on the board, in column-then-position order. Every browser subscribes to this one query. */
export const list = query.query(async ({ ctx }): Promise<Doc<"tasks">[]> => ctx.db.query("tasks").withIndex("by_status_and_order").order("asc").collect());

/**
 * Append a card to the bottom of a column. The order key is derived server-side
 * from the column's current tail inside the mutation's transaction, so two
 * people adding a card at the same moment cannot mint the same key.
 */
export const create = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({
        title: v.string().max(200),
        status: v.optional(v.union(v.literal("todo"), v.literal("in-progress"), v.literal("done"), v.literal("archived"))),
    })
    .mutation(async ({ args: { title, status: column }, ctx }): Promise<Id<"tasks">> => {
        const target = (column ?? "todo") as Status;
        const cards = await ctx.db
            .query("tasks")
            .withIndex("by_status_and_order", (q) => q.eq("status", target))
            .order("asc")
            .collect();

        const id = await ctx.db.insert("tasks", { order: midpoint(cards.at(-1)?.order ?? null, null), status: target, title });

        ctx.log.info("task created", { id, status: target });

        return id;
    });

export const rename = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ id: v.id("tasks"), title: v.string().max(200) })
    .mutation(async ({ args: { id, title }, ctx }): Promise<void> => {
        ctx.log.info("task renamed", { id });
        await ctx.db.patch(id, { title });
    });

/**
 * Move a card to `index` within `status` — the drop position, not an order key.
 *
 * Resolving the key here rather than in the browser is the whole point of the
 * fractional index: the mutation reads the destination column and computes the
 * midpoint of the two cards that will surround the dropped one, all inside one
 * transaction. A client that dropped against a slightly stale board still lands
 * in the right place, and the write touches exactly one row.
 */
export const move = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ id: v.id("tasks"), status: v.union(v.literal("todo"), v.literal("in-progress"), v.literal("done"), v.literal("archived")), index: v.number() })
    .mutation(async ({ args: { id, index, status: column }, ctx }): Promise<void> => {
        const card = await ctx.db.get(id);

        if (!card) {
            return;
        }

        const target = column as Status;
        const cards = await ctx.db
            .query("tasks")
            .withIndex("by_status_and_order", (q) => q.eq("status", target))
            .order("asc")
            .collect();

        // The dragged card never counts as its own neighbour.
        const neighbours = cards.filter((row) => row._id !== id);
        const position = Math.max(0, Math.min(Math.trunc(index), neighbours.length));

        ctx.log.info("task moved", { from: card.status, id, index: position, to: target });
        await ctx.db.patch(id, { order: midpoint(neighbours[position - 1]?.order ?? null, neighbours[position]?.order ?? null), status: target });
    });

export const remove = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ id: v.id("tasks") })
    .mutation(async ({ args: { id }, ctx }): Promise<void> => {
        ctx.log.info("task removed", { id });
        await ctx.db.delete(id);
    });
