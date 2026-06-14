import { CirrusError } from "@cirrus/server";

import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";
import { assertWithinQuota } from "./entitlements";

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
export const list = query({
    args: { organizationId: v.id("organizations") },
    handler: async (context, { organizationId }): Promise<MemberRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.members.findMany({ where: { organizationId } });

        return page as unknown as MemberRow[];
    },
});

/** Add a member to an organization (owners/admins only). Idempotent per user. */
export const add = mutation({
    args: { organizationId: v.id("organizations"), role, userId: v.string() },
    handler: async (context, arguments_): Promise<Id<"members">> => {
        await assertMember(context, arguments_.organizationId, ["owner", "admin"]);

        const { page } = await context.db.members.findMany({
            where: { organizationId: arguments_.organizationId, userId: arguments_.userId },
        });

        const existing = (page as unknown as MemberRow[])[0];

        if (existing) {
            throw new CirrusError("CONFLICT", "user is already a member");
        }

        const all = await context.db.members.findMany({ where: { organizationId: arguments_.organizationId } });

        await assertWithinQuota(context, arguments_.organizationId, "members", (all.page as unknown as MemberRow[]).length);

        return context.db.insert("members", {
            createdAt: Date.now(),
            organizationId: arguments_.organizationId,
            role: arguments_.role,
            userId: arguments_.userId,
        });
    },
});

/** Remove a member (owners/admins only). */
export const remove = mutation({
    args: { id: v.id("members"), organizationId: v.id("organizations") },
    handler: async (context, { id, organizationId }): Promise<void> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "member");

        await context.db.delete(id);
    },
});
