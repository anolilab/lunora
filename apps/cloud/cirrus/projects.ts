import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";

interface ProjectRow {
    _id: Id<"projects">;
    createdAt: number;
    framework?: string;
    name: string;
    organizationId: Id<"organizations">;
    slug: string;
}

/** List an organization's projects. */
export const listByOrg = query({
    args: { organizationId: v.id("organizations") },
    handler: async (context, { organizationId }): Promise<ProjectRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.projects.findMany({ where: { organizationId } });

        return page;
    },
});

/**
 * Create a project in an organization. Per-org slug uniqueness is enforced by
 * the composite `by_org_slug` unique index — a duplicate raises a constraint
 * error the runtime surfaces as a CirrusError.
 */
export const create = mutation({
    args: { framework: v.optional(v.string()), name: v.string(), organizationId: v.id("organizations"), slug: v.string() },
    handler: async (context, arguments_): Promise<Id<"projects">> => {
        await assertMember(context, arguments_.organizationId, ["owner", "admin", "member"]);

        return context.db.insert("projects", {
            createdAt: Date.now(),
            framework: arguments_.framework,
            name: arguments_.name,
            organizationId: arguments_.organizationId,
            slug: arguments_.slug,
        });
    },
});
