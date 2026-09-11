import { LunoraError } from "lunorash/errors";
import { rateLimit } from "lunorash/ratelimit";

import { mutation, query, v } from "#lunora/_generated/server.js";

import { projectsReadRls, projectsWriteRls, requireOwner } from "./authz";
import { limiter, limitKey } from "./limits";

/** Cap on a page of projects, so a dashboard query can't ask for the whole table. */
const MAX_PAGE = 100;

/**
 * The dashboard list — the CALLER'S projects, most recently touched first.
 *
 * Two things narrow this, and they are not redundant. `.use(projectsReadRls)` is
 * the security boundary: the read policy AND-merges `ownerId = auth.userId` into
 * every query against `projects`, and denies outright when the caller is
 * anonymous — so no handler can leak another account's rows by forgetting a
 * filter. The `by_owner_updated` index is the *performance* half: `projects` is
 * `.global()`, and letting the policy filter a `by_updated` scan would read every
 * user's rows out of D1 to return one user's page.
 */
export const list = query
    .input({ limit: v.optional(v.number()) })
    .use(projectsReadRls)
    .query(async ({ args, ctx }) => {
        const ownerId = requireOwner(ctx);
        const limit = Math.min(args.limit ?? 20, MAX_PAGE);

        const projects = await ctx.db
            .query("projects")
            .withIndex("by_owner_updated", (q) => q.eq("ownerId", ownerId))
            .order("desc")
            .take(limit);

        return { projects };
    });

/**
 * Start a project. The row is created here; the sandbox that scaffolds it is
 * plan 335's W2, and until that lands a project exists without a working tree.
 *
 * `ownerId` is bound from the session, never from `args` — the whole ownership
 * model downstream reads this column, so a caller-supplied owner would let
 * anyone mint a project into somebody else's dashboard. The RLS insert policy
 * re-checks it on the candidate row, so the binding is enforced rather than
 * merely intended.
 */
export const create = mutation
    .input({
        name: v.string().meta({ schema: { maxLength: 120 } }),
        template: v.optional(v.string().meta({ schema: { maxLength: 64 } })),
    })
    .use(rateLimit(limiter, "write", { key: limitKey }))
    .use(projectsWriteRls)
    .mutation(async ({ args, ctx }) => {
        const ownerId = requireOwner(ctx);
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

        const id = await ctx.db.insert("projects", { createdAt: now, name, ownerId, template, updatedAt: now });

        ctx.log.info("project.create", { projectId: id, template });

        return { id, name };
    });

/**
 * Rename a project, keeping `updatedAt` honest so the dashboard re-sorts.
 *
 * `args.id` is a caller-supplied identifier, so the patch runs under
 * `projectsWriteRls`: the update policy evaluates the PRE-WRITE row, and a row
 * the caller does not own denies with `FORBIDDEN` instead of renaming somebody
 * else's project.
 */
export const rename = mutation
    .input({ id: v.id("projects"), name: v.string().meta({ schema: { maxLength: 120 } }) })
    .use(rateLimit(limiter, "write", { key: limitKey }))
    .use(projectsWriteRls)
    .mutation(async ({ args, ctx }) => {
        requireOwner(ctx);

        const name = args.name.trim();

        if (name.length === 0) {
            throw new LunoraError("BAD_REQUEST", "A project needs a name");
        }

        await ctx.db.patch(args.id, { name, updatedAt: Date.now() });

        ctx.log.info("project.rename", { projectId: args.id });

        return { id: args.id, name };
    });
