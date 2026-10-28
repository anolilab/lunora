/**
 * Organisation onboarding: an owner or admin starts the durable `onboarding`
 * workflow once per organisation; its steps call back into the internal
 * functions below.
 *
 * The welcome mail goes to the caller's own verified address, looked up
 * server-side from better-auth — never to an address from the request, which
 * would turn this into a relay for mail to anyone.
 */
import { LunoraError } from "@lunora/errors";

import { internalAction, internalMutation, internalQuery, v } from "./_generated/server.js";
import type { AuthEnv } from "./auth/index.js";
import { getAuth } from "./auth/index.js";
import { orgBulkMutation, requireWriter } from "./lib/crpc.js";

/**
 * Idempotent per organisation: the instance id is derived from the tenant, so a
 * second start reports the first instance instead of mailing again. The `bulk`
 * budget (5 per minute per caller) bounds retries.
 */
export const start = orgBulkMutation.mutation(async ({ ctx }) => {
    const { organizationId, userId } = await requireWriter(ctx);
    const id = `onboarding-${organizationId}`;
    const { created } = await ctx.workflows.get("onboarding").createBatch({ instances: [{ id, params: { organizationId, userId } }] });

    return { instanceId: id, started: created.length === 1 };
});

/** The user's verified email, or a refusal: an unverified address is not one to mail. */
export const recipient = internalAction.input({ userId: v.string() }).action(async ({ args, ctx }): Promise<{ email: string }> => {
    const { adapter } = await getAuth(ctx.env as unknown as AuthEnv).$context;
    const user = await adapter.findOne<{ email: string; emailVerified: boolean }>({ model: "user", where: [{ field: "id", value: args.userId }] });

    if (!user?.emailVerified) {
        throw new LunoraError("UNPROCESSABLE", "onboarding: the user has no verified email address");
    }

    return { email: user.email };
});

export const seedOrganization = internalMutation.input({ organizationId: v.string(), userId: v.string() }).mutation(async ({ args, ctx }) => {
    const existing = await ctx.db
        .query("tasks")
        .withIndex("byOrgStatus", (q) => q.eq("organizationId", args.organizationId))
        .first();

    if (existing) {
        return { seeded: false };
    }

    const now = Date.now();

    await ctx.db.insert("tasks", {
        createdAt: now,
        createdBy: args.userId,
        labels: ["onboarding"],
        organizationId: args.organizationId,
        priority: "normal",
        status: "todo",
        title: "Invite your team",
        updatedAt: now,
    });

    return { seeded: true };
});

export const progress = internalQuery.input({ organizationId: v.string() }).query(async ({ args, ctx }) => {
    const tasks = await ctx.db
        .query("tasks")
        .withIndex("byOrgStatus", (q) => q.eq("organizationId", args.organizationId))
        .take(10);

    return { tasks: tasks.length };
});
