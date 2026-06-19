import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";

interface OrganizationRow {
    _id: Id<"organizations">;
    cellId: Id<"cells">;
    createdAt: number;
    name: string;
    plan: "enterprise" | "free" | "pro";
    slug: string;
}

const assertSignedIn = (userId: null | string): string => {
    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    return userId;
};

/** List all organizations (platform-admin surface). `.global()` → D1 facade. */
export const list = query.query(async ({ ctx: context }): Promise<OrganizationRow[]> => {
    const { page } = await context.db.organizations.findMany();

    return page as unknown as OrganizationRow[];
});

/**
 * Look an organization up by its URL slug. `organizations` is `.global()`, so
 * we read through the facade and match in memory — org volume is tiny, and the
 * `by_slug` unique index still enforces correctness on insert.
 */
export const getBySlug = query.input({ slug: v.string() }).query(async ({ ctx: context, args: { slug } }): Promise<OrganizationRow | null> => {
    const { page } = await context.db.organizations.findMany();

    return (page as unknown as OrganizationRow[]).find((organization) => organization.slug === slug) ?? null;
});

/**
 * Create an organization on a given cell, seed its creator as `owner`, and
 * record the action in the audit log. Slug uniqueness is enforced by the
 * `by_slug` global (D1) unique index.
 */
export const create = mutation
    .input({
        cellId: v.id("cells"),
        name: v.string(),
        plan: v.optional(v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise"))),
        slug: v.string(),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"organizations">> => {
        const userId = assertSignedIn(context.auth.userId);
        const now = Date.now();

        const organizationId = await context.db.insert("organizations", {
            cellId: arguments_.cellId,
            createdAt: now,
            name: arguments_.name,
            plan: arguments_.plan ?? "free",
            slug: arguments_.slug,
        });

        await context.db.insert("members", {
            createdAt: now,
            organizationId,
            role: "owner",
            userId,
        });

        await context.db.insert("auditLog", {
            action: "organization.create",
            actorUserId: userId,
            createdAt: now,
            organizationId,
            target: arguments_.slug,
        });

        return organizationId;
    });
