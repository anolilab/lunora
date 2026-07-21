import { LunoraError } from "@lunora/server";

import { hashDeployKey } from "../src/deploy/keys";
import type { Id, TableName } from "./_generated/dataModel.js";
import type { QueryCtx as QueryContext } from "./_generated/server.js";

/**
 * Organization authorization (CLOUD-PLAN.md §2.2 / §7 ACLs). Org-scoped
 * functions authorize one of two ways:
 *
 * - **User session** → {@link assertMember}: the caller must be a member of the
 *   org (the dashboard path). Closes the IDOR hole where any signed-in user
 *   could touch any org by passing its id.
 * - **Deploy key** → {@link authorizeDeployKey}: the CI/deploy path has no user
 *   session; a valid, unrevoked deploy key for the org (and project, if the key
 *   is project-scoped) is the credential.
 */

export type MemberRole = "admin" | "member" | "owner" | "viewer";

interface MemberRow {
    _id: Id<"members">;
    organizationId: Id<"organizations">;
    role: MemberRole;
    userId: string;
}

interface DeployKeyRow {
    _id: Id<"deployKeys">;
    organizationId: Id<"organizations">;
    projectId?: Id<"projects">;
    revokedAt?: number;
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
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    const { page } = await context.db.members.findMany({ where: { organizationId, userId } });
    const member = (page as unknown as MemberRow[])[0];

    if (!member) {
        throw new LunoraError("FORBIDDEN", "not a member of this organization");
    }

    if (allowedRoles && !allowedRoles.includes(member.role)) {
        throw new LunoraError("FORBIDDEN", `requires one of: ${allowedRoles.join(", ")}`);
    }

    return { role: member.role, userId };
};

/**
 * Authorize a deploy-key-credentialed write to an organization. Matches the key
 * by SHA-256 against the stored hash, rejecting it if missing, revoked, scoped
 * to a different org, or (for a project-scoped key) used against another
 * project. Returns the resolved deploy-key id on success.
 */
export const authorizeDeployKey = async (
    context: QueryContext,
    organizationId: Id<"organizations">,
    key: string,
    projectId?: Id<"projects">,
): Promise<Id<"deployKeys">> => {
    const hashedKey = await hashDeployKey(key);
    const { page } = await context.db.deployKeys.findMany({ where: { hashedKey } });
    const row = (page as unknown as DeployKeyRow[])[0];

    if (!row || row.revokedAt !== undefined || row.organizationId !== organizationId) {
        throw new LunoraError("FORBIDDEN", "invalid deploy key for this organization");
    }

    if (row.projectId !== undefined && projectId !== undefined && row.projectId !== projectId) {
        throw new LunoraError("FORBIDDEN", "deploy key is not authorized for this project");
    }

    return row._id;
};

/**
 * Resolve a deploy key to its owning org from the key ALONE (no org supplied) —
 * for the standard OTLP endpoints, where a stock OpenTelemetry exporter presents
 * only an `Authorization: Bearer <key>` header and no body auth fields. Matches
 * the key by SHA-256 against the unique `by_hash` index. Returns `null` for an
 * unknown or revoked key (so the caller returns 401, never leaking which it was).
 */
export const resolveDeployKeyOrg = async (context: QueryContext, key: string): Promise<Id<"organizations"> | null> => {
    const hashedKey = await hashDeployKey(key);
    const { page } = await context.db.deployKeys.findMany({ where: { hashedKey } });
    const row = (page as unknown as DeployKeyRow[])[0];

    return row && row.revokedAt === undefined ? row.organizationId : null;
};

/**
 * Assert that a row exists and belongs to `organizationId`, throwing `NOT_FOUND`
 * otherwise. Guards the cross-org IDOR on org-scoped delete/revoke mutations:
 * being an owner/admin of org A must not let you mutate org B's row by passing
 * A's id with B's row id. Centralized here so the check (and its error contract)
 * lives in one place.
 */
export const assertRowInOrg = async <T extends TableName>(
    context: QueryContext,
    id: Id<T>,
    organizationId: Id<"organizations">,
    label: string,
): Promise<void> => {
    const row = (await context.db.get(id)) as { organizationId?: Id<"organizations"> } | null;

    if (row?.organizationId !== organizationId) {
        throw new LunoraError("NOT_FOUND", `${label} not found in this organization`);
    }
};
