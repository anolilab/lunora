import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";
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
export const listByOrg = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<ProjectRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.projects.findMany({ where: { organizationId } });

        return page;
    });

/** Resolve a project by its connected GitHub repository (`owner/name`). */
export const byGithubRepo = query
    .input({ repository: v.string() })
    .query(async ({ ctx: context, args: { repository } }): Promise<null | { organizationId: Id<"organizations">; projectId: Id<"projects">; slug: string }> => {
        const { page } = await context.db.projects.findMany({ where: { githubRepo: repository } });
        const project = (page as unknown as ProjectRow[])[0];

        return project ? { organizationId: project.organizationId, projectId: project._id, slug: project.slug } : null; // secret-scanner:allow -- domain field name
    });

/**
 * Create a project in an organization. Per-org slug uniqueness is enforced by
 * the composite `by_org_slug` unique index; the org's live entitlements cap
 * project count (resolved from its synced subscription state, not the static
 * `plan` column — see `lunora/entitlements.ts`).
 */
export const create = mutation
    .input({
        framework: v.optional(v.string()),
        githubRepo: v.optional(v.string()),
        name: v.string(),
        organizationId: v.id("organizations"),
        slug: v.string(),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"projects">> => {
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
    });

/** Rename a project (owner/admin). The slug (and its URL alias) is immutable. */
export const rename = mutation
    .input({ id: v.id("projects"), name: v.string(), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, name, organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, id, organizationId, "project");
        await context.db.patch(id, { name });
        await context.db.insert("auditLog", { action: "project.rename", actorUserId: member.userId, createdAt: Date.now(), organizationId, target: name });
    });
