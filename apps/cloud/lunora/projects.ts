import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { assertWithinQuota } from "./entitlements";

interface ProjectRow {
    _id: Id<"projects">;
    createdAt: number;
    framework?: string;
    githubRepo?: string;
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

/** Resolve a project by its connected GitHub repository (`owner/name`). */
export const byGithubRepo = query({
    args: { repository: v.string() },
    handler: async (context, { repository }): Promise<null | { organizationId: Id<"organizations">; projectId: Id<"projects">; slug: string }> => {
        const { page } = await context.db.projects.findMany({ where: { githubRepo: repository } });
        const project = (page as unknown as ProjectRow[])[0];

        return project ? { organizationId: project.organizationId, projectId: project._id, slug: project.slug } : null; // secret-scanner:allow -- domain field name
    },
});

/**
 * Create a project in an organization. Per-org slug uniqueness is enforced by
 * the composite `by_org_slug` unique index; the org's live entitlements cap
 * project count (resolved from its synced subscription state, not the static
 * `plan` column — see `lunora/entitlements.ts`).
 */
export const create = mutation({
    args: {
        framework: v.optional(v.string()),
        githubRepo: v.optional(v.string()),
        name: v.string(),
        organizationId: v.id("organizations"),
        slug: v.string(),
    },
    handler: async (context, arguments_): Promise<Id<"projects">> => {
        await assertMember(context, arguments_.organizationId, ["owner", "admin", "member"]);

        const { page } = await context.db.projects.findMany({ where: { organizationId: arguments_.organizationId } });

        await assertWithinQuota(context, arguments_.organizationId, "projects", (page as unknown as ProjectRow[]).length);

        return context.db.insert("projects", {
            createdAt: Date.now(),
            framework: arguments_.framework,
            githubRepo: arguments_.githubRepo,
            name: arguments_.name,
            organizationId: arguments_.organizationId,
            slug: arguments_.slug,
        });
    },
});
