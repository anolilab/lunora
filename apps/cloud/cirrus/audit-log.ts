import type { Id } from "./_generated/dataModel.js";
import { mutation, v } from "./_generated/server.js";
import { assertMember } from "./authz";

/**
 * Append an audit-log entry (CLOUD-PLAN.md §3). Members only; used by the
 * hosted-studio admin proxy and other flows that need a durable record of who
 * did what.
 */
export const record = mutation({
    args: { action: v.string(), organizationId: v.id("organizations"), target: v.optional(v.string()) },
    handler: async (context, arguments_): Promise<Id<"auditLog">> => {
        const { userId } = await assertMember(context, arguments_.organizationId);

        return context.db.insert("auditLog", {
            action: arguments_.action,
            actorUserId: userId,
            createdAt: Date.now(),
            organizationId: arguments_.organizationId,
            target: arguments_.target,
        });
    },
});
