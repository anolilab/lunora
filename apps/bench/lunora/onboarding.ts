/**
 * Organisation onboarding: an owner or admin starts the durable `onboarding`
 * workflow once per organisation; its steps call back into the internal
 * functions below.
 *
 * The welcome mail goes to the caller's own verified address, from the
 * `email` identity claim the Worker resolves from better-auth, never
 * to an address from the request, which would turn this into a relay for mail
 * to anyone.
 */
import { LunoraError } from "@lunora/errors";

import { internalMutation, internalQuery, v } from "./_generated/server";
import { orgBulkMutation, requireWriter } from "./lib/crpc";

/**
 * Idempotent per organisation: the instance id is derived from the tenant, so a
 * second start reports the running instance instead of mailing again. An
 * instance that errored is restarted, which runs every step again; the welcome
 * mail is claimed once per organisation (`saas:claimWelcome`), so it is not sent
 * twice. The `bulk` budget (5 per minute per caller) bounds retries.
 */
export const start = orgBulkMutation.mutation(async ({ ctx }) => {
    const { organizationId, userId } = await requireWriter(ctx);
    const identity = await ctx.auth.getIdentity();
    const email = identity?.email;

    if (email === undefined) {
        throw new LunoraError("UNPROCESSABLE", "onboarding: the session carries no email address");
    }

    const id = `onboarding-${organizationId}`;
    const workflow = ctx.workflows.get("onboarding");
    const { created } = await workflow.createBatch({ instances: [{ id, params: { email, organizationId, userId } }] });

    if (created.length === 1) {
        return { instanceId: id, started: true };
    }

    const instance = await workflow.get(id);
    const { status } = await instance.status();

    if (status !== "errored") {
        return { instanceId: id, started: false };
    }

    await instance.restart();

    return { instanceId: id, started: true };
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
