import type { Doc as Document_, Id } from "./_generated/dataModel.js";
import { internalMutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

type AuditRow = Document_<"auditLog">;

/**
 * Append an audit-log entry. Members only; used by the
 * hosted-studio admin proxy and other flows that need a durable record of who
 * did what.
 */
export const record = internalMutation
    .use(rateLimit("api"))
    .input({
        action: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
        target: v.optional(boundedString(LIMITS.token)),
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

/** Newest entries one read returns. */
const AUDIT_LOG_PAGE = 200;

/** An organization's audit-log entries, newest first (members only). */
export const list = query.input({ organizationId: v.id("organizations") }).query(async ({ ctx: context, args: { organizationId } }): Promise<AuditRow[]> => {
    await assertMember(context, organizationId);

    // Newest first in the query, bounded: reading the whole history and sorting it in
    // memory breaks past one page, and the Activity tab only shows recent entries.
    const { page } = await context.db.auditLog.findMany({ limit: AUDIT_LOG_PAGE, orderBy: [{ createdAt: "desc" }], where: { organizationId } });

    return page;
});
