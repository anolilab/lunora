import { CirrusError } from "@cirrus/server";

import type { Id } from "./_generated/dataModel.js";
import type { QueryCtx as QueryContext } from "./_generated/server.js";

/**
 * Organization authorization (CLOUD-PLAN.md §2.2 / §7 ACLs). Every org-scoped
 * function must prove the caller is a member of the org it addresses — otherwise
 * a signed-in user could read or mutate any org's projects, deployments, and
 * keys just by passing its id. `assertMember` is the single gate for that.
 */

export type MemberRole = "admin" | "member" | "owner" | "viewer";

interface MemberRow {
    _id: Id<"members">;
    organizationId: Id<"organizations">;
    role: MemberRole;
    userId: string;
}

/**
 * Resolve and authorize the caller's membership in an organization. Throws
 * `UNAUTHORIZED` if not signed in, `FORBIDDEN` if not a member (or, when
 * `allowedRoles` is given, if the member's role isn't permitted). Works in both
 * queries and mutations (the reader facade is shared).
 */
export const assertMember = async (
    context: QueryContext,
    organizationId: Id<"organizations">,
    allowedRoles?: ReadonlyArray<MemberRole>,
): Promise<{ role: MemberRole; userId: string }> => {
    const { userId } = context.auth;

    if (!userId) {
        throw new CirrusError("UNAUTHORIZED", "not signed in");
    }

    const { page } = await context.db.members.findMany({ where: { organizationId, userId } });
    const member = (page as unknown as MemberRow[])[0];

    if (!member) {
        throw new CirrusError("FORBIDDEN", "not a member of this organization");
    }

    if (allowedRoles && !allowedRoles.includes(member.role)) {
        throw new CirrusError("FORBIDDEN", `requires one of: ${allowedRoles.join(", ")}`);
    }

    return { role: member.role, userId };
};
