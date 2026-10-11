import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { internalQuery, mutation, query, v } from "./_generated/server.js";
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
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "member");

        await context.db.delete(id);
    });

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
            target: `${target.userId} → ${newRole}`,
        });
    });
