import { LunoraError } from "@lunora/server";

import { query } from "./_generated/server.js";

/** Rows per list in one export. A caller with more than this gets the first page and a flag. */
const EXPORT_LIMIT = 1000;

/**
 * The personal data the control plane holds about the signed-in caller, as a
 * machine-readable document (GDPR Art. 15 access and Art. 20 portability).
 *
 * It covers what the control plane itself stores under the caller's user id:
 * their memberships, and the audit entries they authored. The account profile
 * (email, name, sign-in methods) is held by the authentication layer and is not
 * in this document. Lists are capped at {@link EXPORT_LIMIT}; `truncated` says
 * when a list was cut off. It is a bounded read behind sign-in, so it takes no
 * write-side rate limit.
 */
export const exportMine = query.query(async ({ ctx: context }): Promise<Record<string, unknown>> => {
    const { userId } = context.auth;

    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    const { page: memberships } = await context.db.members.findMany({ limit: EXPORT_LIMIT, where: { userId } });
    const { page: entries } = await context.db.auditLog.findMany({
        limit: EXPORT_LIMIT,
        orderBy: [{ createdAt: "asc" }],
        where: { actorUserId: userId },
    });

    return {
        auditEntries: entries.map((entry) => {
            return {
                action: entry.action,
                createdAt: entry.createdAt,
                organizationId: entry.organizationId,
                target: entry.target ?? null,
            };
        }),
        exportedAt: context.now,
        format: "lunora-account-export/1",
        memberships: memberships.map((membership) => {
            return {
                createdAt: membership.createdAt,
                organizationId: membership.organizationId,
                role: membership.role,
            };
        }),
        truncated: memberships.length === EXPORT_LIMIT || entries.length === EXPORT_LIMIT,
    };
});
