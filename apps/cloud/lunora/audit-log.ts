import { dbRateLimit } from "@lunora/ratelimit";

import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { callerKey, RATE_LIMITS } from "./guards";

interface AuditRow {
    _id: Id<"auditLog">;
    action: string;
    actorUserId: string;
    createdAt: number;
    organizationId: Id<"organizations">;
    target?: string;
}

/**
 * Append an audit-log entry (CLOUD-PLAN.md §3). Members only; used by the
 * hosted-studio admin proxy and other flows that need a durable record of who
 * did what.
 */
export const record = mutation
    .use(dbRateLimit(RATE_LIMITS, "api", { key: callerKey }))
    .input({
        action: v.string().check((value) => value.length <= 128, { message: "must be at most 128 characters", schema: { maxLength: 128 } }),
        organizationId: v.id("organizations"),
        target: v.optional(v.string().check((value) => value.length <= 256, { message: "must be at most 256 characters", schema: { maxLength: 256 } })),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"auditLog">> => {
        // Restricted to owner/admin: the `action`/`target` are free-form, so a plain
        // member (esp. a viewer) could otherwise forge security-relevant entries
        // (e.g. "organization.suspend") into the very log used for forensics. All
        // system-originated audit writes insert directly, not via this mutation.
        const { userId } = await assertMember(context, arguments_.organizationId, ["owner", "admin"]);

        return context.db.insert("auditLog", {
            action: arguments_.action,
            actorUserId: userId,
            createdAt: context.now,
            organizationId: arguments_.organizationId,
            target: arguments_.target,
        });
    });

/** An organization's audit-log entries, newest first (members only). */
export const list = query.input({ organizationId: v.id("organizations") }).query(async ({ ctx: context, args: { organizationId } }): Promise<AuditRow[]> => {
    await assertMember(context, organizationId);

    const { page } = await context.db.auditLog.findMany({ where: { organizationId } });

    return (page as unknown as AuditRow[]).toSorted((a, b) => b.createdAt - a.createdAt);
});
