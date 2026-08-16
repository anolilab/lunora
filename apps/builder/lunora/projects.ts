import { LunoraError } from "lunorash/errors";
import { createDbStore, rateLimit, RateLimiter } from "lunorash/ratelimit";

import type { MutationCtx } from "#lunora/_generated/server.js";
import { mutation, query, v } from "#lunora/_generated/server.js";

/** Cap on a page of projects, so a dashboard query can't ask for the whole table. */
const MAX_PAGE = 100;

/**
 * Write limiter for the public project mutations.
 *
 * Typed against the generated `MutationCtx` so `rateLimit(limiter, …)` infers
 * the full procedure context — `ctx.auth` in the key callback and a typed
 * `ctx.db` in the downstream handler both depend on it.
 *
 * This is **abuse protection, not the product's quota**. Plan 335 §D17 meters
 * turns and tokens through `tokenBudget`, which is W7; this only stops an
 * unauthenticated caller minting projects in a loop, which is a public write
 * path the advisor rightly flags (`public_mutation_without_ratelimit`).
 */
const limiter = (ctx: MutationCtx) =>
    new RateLimiter({
        config: {
            write: { kind: "token bucket", period: 60_000, rate: 20 },
        },
        store: createDbStore({ db: ctx.db, table: "ratelimit_buckets" }),
    });

/** Anonymous callers share a bucket per session; signed-in ones get their own. */
const limitKey = (ctx: { auth: { userId?: string | null } }) => ctx.auth.userId ?? "anon";

/**
 * The dashboard list — most recently touched first.
 *
 * Served from the `by_updated` index rather than a scan-and-sort: `projects` is
 * `.global()`, so an unindexed order-by here would be a D1 table scan on the
 * first page every user sees.
 */
export const list = query.input({ limit: v.optional(v.number()) }).query(async ({ args, ctx }) => {
    const limit = Math.min(args.limit ?? 20, MAX_PAGE);

    const projects = await ctx.db
        .query("projects")
        .withIndex("by_updated", (q) => q)
        .order("desc")
        .take(limit);

    return { projects };
});

/**
 * Start a project. The row is created here; the sandbox that scaffolds it is
 * plan 335's W2, and until that lands a project exists without a working tree.
 */
export const create = mutation
    .input({
        name: v.string().meta({ schema: { maxLength: 120 } }),
        template: v.optional(v.string().meta({ schema: { maxLength: 64 } })),
    })
    .use(rateLimit(limiter, "write", { key: limitKey }))
    .mutation(async ({ args, ctx }) => {
        const name = args.name.trim();

        if (name.length === 0) {
            throw new LunoraError("BAD_REQUEST", "A project needs a name");
        }

        // One clock read for both fields: two `Date.now()` calls can straddle a
        // millisecond, and a project whose `updatedAt` precedes its `createdAt`
        // sorts before its own creation in the dashboard.
        const now = Date.now();

        // `tanstack-start-react` is the default (plan 335 §D12) — the builder's
        // own stack, so one path is dogfooded by both halves of the product.
        const template = args.template ?? "tanstack-start-react";

        const id = await ctx.db.insert("projects", { createdAt: now, name, template, updatedAt: now });

        ctx.log.info("project.create", { projectId: id, template });

        return { id, name };
    });

/** Rename a project, keeping `updatedAt` honest so the dashboard re-sorts. */
export const rename = mutation
    .input({ id: v.id("projects"), name: v.string().meta({ schema: { maxLength: 120 } }) })
    .use(rateLimit(limiter, "write", { key: limitKey }))
    .mutation(async ({ args, ctx }) => {
        const name = args.name.trim();

        if (name.length === 0) {
            throw new LunoraError("BAD_REQUEST", "A project needs a name");
        }

        await ctx.db.patch(args.id, { name, updatedAt: Date.now() });

        ctx.log.info("project.rename", { projectId: args.id });

        return { id: args.id, name };
    });
