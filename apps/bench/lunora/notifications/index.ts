/**
 * The in-app notification feed (per tenant shard) and the device-push plane.
 */
import { action, internalMutation, v } from "../_generated/server.js";
import { orgMutation, orgQuery, requireOrg, tenantRead, tenantWrite } from "../lib/crpc.js";

/** Written by the `events` queue consumer, on the tenant's shard. */
export const record = internalMutation
    .input({ kind: v.string().max(64), organizationId: v.string(), subjectId: v.optional(v.string()) })
    .mutation(async ({ args, ctx }) =>
        ctx.db.insert("notifications", {
            createdAt: Date.now(),
            kind: args.kind,
            organizationId: args.organizationId,
            readAt: undefined,
            subjectId: args.subjectId,
        }),
    );

export const list = orgQuery
    .use(tenantRead("notifications"))
    .input({ unreadOnly: v.optional(v.boolean()) })
    .query(async ({ args, ctx }) => {
        const { organizationId } = await requireOrg(ctx);
        const pageSize = await ctx.flags.number("page_size", 25);
        const rows = await ctx.db
            .query("notifications")
            .withIndex("byOrgCreatedAt", (q) => q.eq("organizationId", organizationId))
            .order("desc")
            .take(pageSize);

        return args.unreadOnly ? rows.filter((row) => row.readAt === undefined) : rows;
    });

export const markRead = orgMutation
    .use(tenantWrite("notifications"))
    .input({ id: v.id("notifications") })
    .mutation(async ({ args, ctx }) => {
        await requireOrg(ctx);
        await ctx.db.patch("notifications", args.id, { readAt: Date.now() });

        return { ok: true as const };
    });

export const registerDevice = orgMutation
    .input({ subscription: v.object({ endpoint: v.string().max(2048), keys: v.object({ auth: v.string(), p256dh: v.string() }) }) })
    .mutation(async ({ args, ctx }) => {
        const { userId } = await requireOrg(ctx);

        await ctx.push.register({ subscription: args.subscription, userId });

        return { ok: true as const };
    });

/** Push to every device of the caller (a "test notification" button). Sends are action-only. */
export const testPush = action.action(async ({ ctx }) => {
    const { userId } = ctx.auth;

    if (!userId) {
        return { delivered: false };
    }

    await ctx.push.broadcast({ body: "Push works.", title: "Lunora bench" }, { userId });

    return { delivered: true };
});
