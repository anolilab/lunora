import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRoleForUser, assertRowInOrg } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * The role a verified user holds in an organization, or the refusal when they hold none
 * of `allowedRoles`. The app catalog's install route passes the session's user id, so
 * its owner-or-admin check is {@link assertRoleForUser}, the same rule `assertMember`
 * applies. An internal query: a public one would answer role questions about any user
 * in any organization.
 */
export const roleForUser = internalQuery
    .input({
        allowedRoles: v.array(v.union(v.literal("admin"), v.literal("member"), v.literal("owner"), v.literal("viewer"))),
        organizationId: v.id("organizations"),
        userId: boundedString(LIMITS.id),
    })
    .query(async ({ ctx: context, args: { allowedRoles, organizationId, userId } }): Promise<"admin" | "member" | "owner" | "viewer"> => {
        const member = await assertRoleForUser(context, organizationId, userId, allowedRoles);

        return member.role;
    });

interface MemberRow {
    _id: Id<"members">;
    createdAt: number;
    organizationId: Id<"organizations">;
    // Inlined literal union (not the MemberRole alias) so codegen serializes the
    // return type without an unresolved type reference.
    role: "admin" | "member" | "owner" | "viewer";
    userId: string;
}

/** List an organization's members. Any member may view the roster. */
export const list = query.input({ organizationId: v.id("organizations") }).query(async ({ ctx: context, args: { organizationId } }): Promise<MemberRow[]> => {
    await assertMember(context, organizationId);

    const { page } = await context.db.members.findMany({ where: { organizationId } });

    return page;
});

/** Remove a member (owners/admins only). */
export const remove = mutation
    .use(rateLimit("api"))
    .input({ id: v.id("members"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<void> => {
        const caller = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, id, organizationId, "member");

        const target = (await context.db.get(id)) as MemberRow | null;

        // Removing an owner is an owner's decision, and the org must keep one owner.
        if (target?.role === "owner") {
            if (caller.role !== "owner") {
                throw new LunoraError("FORBIDDEN", "only an owner can remove an owner");
            }

            const { page } = await context.db.members.findMany({ where: { organizationId } });

            if (page.filter((member) => member.role === "owner").length <= 1) {
                throw new LunoraError("CONFLICT", "cannot remove the last owner");
            }
        }

        await context.db.delete(id);
    });

/**
 * The `target` of a `member.set-role` audit entry: the membership row's id and
 * the new role, `{members id} → {role}`.
 *
 * Entries written before this format name the member by their user id instead,
 * `{user id} → {role}`. Both shapes are plain strings to every reader (the
 * Activity tab and the account export show `target` as written), so an old
 * entry still displays. The member id names no person: the row is deleted when
 * the member leaves or their account is erased, and the id resolves to nothing
 * afterwards. Old-shape entries are rewritten by `account.eraseUser`
 * ({@link legacySetRoleTargetRole}), which replaces the user id with the
 * deleted-user placeholder.
 */
export const setRoleAuditTarget = (memberId: string, role: string): string => `${memberId} → ${role}`;

/**
 * The role in an old-shape `member.set-role` target that names `userId`
 * (`{user id} → {role}`), or `undefined` when the target is anything else.
 */
export const legacySetRoleTargetRole = (target: string | undefined, userId: string): string | undefined => {
    const prefix = `${userId} → `;

    return target?.startsWith(prefix) ? target.slice(prefix.length) : undefined;
};

/**
 * Change a member's role (owner only). Demoting the last owner is refused —
 * an org must always have one.
 */
export const setRole = mutation
    .use(rateLimit("api"))
    .input({
        id: v.id("members"),
        organizationId: v.id("organizations"),
        role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("viewer")),
    })
    .mutation(async ({ ctx: context, args: { id, organizationId, role: newRole } }): Promise<void> => {
        const caller = await assertMember(context, organizationId, ["owner"]);
        const target = (await context.db.get(id)) as MemberRow | null;

        if (target?.organizationId !== organizationId) {
            throw new LunoraError("NOT_FOUND", "member not found in this organization");
        }

        if (target.role === "owner" && newRole !== "owner") {
            const { page } = await context.db.members.findMany({ where: { organizationId } });
            const owners = page.filter((member) => member.role === "owner");

            if (owners.length <= 1) {
                throw new LunoraError("CONFLICT", "cannot demote the last owner");
            }
        }

        await context.db.patch(id, { role: newRole });
        await context.db.insert("auditLog", {
            action: "member.set-role",
            actorUserId: caller.userId,
            createdAt: context.now,
            organizationId: caller.organizationId,
            target: setRoleAuditTarget(target._id, newRole),
        });
    });

/** The audit actor of an ownership change made through the operator path. */
export const OPERATOR_ACTOR = "system:operator";

/**
 * Make an existing member of an organization one of its owners, through the
 * operator path (`POST /v1/organizations/owners`, admin token only). It is how
 * an operator resolves a removal refused because the user is the organization's
 * only owner: promote another member, then remove the user again.
 *
 * Refused when the organization does not exist or the user is not a member of
 * it. Demotes no one. A member who already is an owner is left as they are, and
 * nothing is written. The change is audited as `member.set-role` by
 * {@link OPERATOR_ACTOR}, with the membership row as the target. SYSTEM only.
 */
export const operatorPromoteOwner = internalMutation
    .input({ organizationId: v.id("organizations"), userId: boundedString(LIMITS.id) })
    .mutation(async ({ ctx: context, args: { organizationId, userId } }): Promise<{ memberId: string; promoted: boolean }> => {
        const organization = await context.db.organizations.get(organizationId);

        if (!organization) {
            throw new LunoraError("NOT_FOUND", "organization not found");
        }

        const { page } = await context.db.members.findMany({ limit: 1, where: { organizationId, userId } });
        const [membership] = page;

        if (!membership) {
            throw new LunoraError("NOT_FOUND", "the user is not a member of this organization");
        }

        if (membership.role === "owner") {
            return { memberId: membership._id, promoted: false };
        }

        await context.db.patch(membership._id, { role: "owner" });
        await context.db.insert("auditLog", {
            action: "member.set-role",
            actorUserId: OPERATOR_ACTOR,
            createdAt: context.now,
            organizationId,
            target: setRoleAuditTarget(membership._id, "owner"),
        });

        return { memberId: membership._id, promoted: true };
    });
