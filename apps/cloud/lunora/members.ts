import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";
import { assertWithinQuota } from "./entitlements";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

interface MemberRow {
    _id: Id<"members">;
    createdAt: number;
    organizationId: Id<"organizations">;
    // Inlined literal union (not the MemberRole alias) so codegen serializes the
    // return type without an unresolved type reference.
    role: "admin" | "member" | "owner" | "viewer";
    userId: string;
}

const role = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("viewer"));

/** List an organization's members. Any member may view the roster. */
export const list = query.input({ organizationId: v.id("organizations") }).query(async ({ ctx: context, args: { organizationId } }): Promise<MemberRow[]> => {
    await assertMember(context, organizationId);

    const { page } = await context.db.members.findMany({ where: { organizationId } });

    return page;
});

/** Add a member to an organization (owners/admins only). Idempotent per user. */
export const add = mutation
    .use(rateLimit("api"))
    .input({
        organizationId: v.id("organizations"),
        role,
        userId: boundedString(LIMITS.name),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"members">> => {
        await assertMember(context, arguments_.organizationId, ["owner", "admin"]);

        const { page } = await context.db.members.findMany({
            where: { organizationId: arguments_.organizationId, userId: arguments_.userId },
        });

        const existing = page[0];

        if (existing) {
            throw new LunoraError("CONFLICT", "user is already a member");
        }

        const all = await context.db.members.findMany({ where: { organizationId: arguments_.organizationId } });

        await assertWithinQuota(context, arguments_.organizationId, "members", all.page.length);

        return context.db.insert("members", {
            createdAt: context.now,
            organizationId: arguments_.organizationId,
            role: arguments_.role,
            userId: arguments_.userId,
        });
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
            organizationId,
            target: `${target.userId} → ${newRole}`,
        });
    });
