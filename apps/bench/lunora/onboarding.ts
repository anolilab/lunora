/**
 * Organisation onboarding: the caller starts the durable `onboarding` workflow,
 * whose steps call back into the two internal functions below on the tenant's
 * shard.
 */
import { internalMutation, internalQuery, v } from "./_generated/server.js";
import { emailSchema, orgMutation, requireWriter } from "./lib/crpc.js";

export const start = orgMutation.input({ email: v.from(emailSchema) }).mutation(async ({ args, ctx }) => {
    const { organizationId, userId } = await requireWriter(ctx);
    const instance = await ctx.workflows.get("onboarding").create({ params: { email: args.email, organizationId, userId } });

    return { instanceId: instance.id };
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
