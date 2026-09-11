/**
 * SaaS kit functions — added by `lunora registry add saas`.
 *
 * This file is YOURS: a normal Lunora module copied into your project. Re-export
 * it from your `lunora/` entry so codegen picks it up — the functions surface in
 * the generated `api` as `saas/overview`, `saas/listProjects`, and so on.
 *
 * Two rules hold everywhere below, and they are the whole tenancy model:
 *
 *   1. **The tenant comes from the identity, never from an argument.** Every
 *      org-scoped function reads `ctx.auth.activeOrganizationId` (declared in
 *      `lunora/identity.ts`, validated at the trust boundary). An
 *      `organizationId` input would be a tenant-escape bug with a type
 *      annotation on it.
 *   2. **A write and the activity row that describes it share one mutation.**
 *      `recordActivity` is a plain helper, not a `runMutation`, so it joins the
 *      caller's transaction: if the write rolls back, the feed entry goes with
 *      it. An activity log that can outlive its event is worse than none.
 */
import { LunoraError } from "@lunora/errors";

import type { Doc, Id } from "#lunora/_generated/server.js";
import { internalMutation, mutation, query, v } from "#lunora/_generated/server.js";

import { SAAS_ACTIVITY_PAGE, SAAS_ACTIVITY_TABLE, SAAS_ORGANIZATIONS_TABLE, SAAS_PROJECTS_TABLE } from "./schema.js";

/** Roles allowed to change an organisation's projects. better-auth's defaults. */
const WRITER_ROLES = new Set(["admin", "owner"]);

/**
 * The caller's verified user id and tenant, or a thrown error. Callers get
 * `UNAUTHORIZED` when there is no session and `FAILED_PRECONDITION` when there
 * is one but no organisation — the two are different screens (sign in vs.
 * create your first organisation), so they must not collapse into one code.
 */
const requireOrganization = (ctx: { auth: { activeOrganizationId?: string; userId?: string } }): { organizationId: string; userId: string } => {
    const { activeOrganizationId, userId } = ctx.auth;

    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    if (!activeOrganizationId) {
        throw new LunoraError("FAILED_PRECONDITION", "no active organization — create or switch to one first");
    }

    return { organizationId: activeOrganizationId, userId };
};

/** As {@link requireOrganization}, and additionally that the caller may write. */
const requireWriter = (ctx: { auth: { activeOrganizationId?: string; orgRole?: string; userId?: string } }): { organizationId: string; userId: string } => {
    const identity = requireOrganization(ctx);

    if (!WRITER_ROLES.has(ctx.auth.orgRole ?? "member")) {
        throw new LunoraError("FORBIDDEN", "requires the admin or owner role in this organization");
    }

    return identity;
};

/**
 * Append to the tenant's activity feed. A helper rather than a function so it
 * runs inside the caller's transaction — see the module docstring.
 */
const recordActivity = async (
    ctx: { db: { insert: (table: string, row: Record<string, unknown>) => Promise<unknown> } },
    entry: { action: string; actorId: string; meta?: Record<string, unknown>; organizationId: string; subjectId?: string; subjectType: string },
): Promise<void> => {
    await ctx.db.insert(SAAS_ACTIVITY_TABLE, { ...entry, createdAt: Date.now() });
};

/** URL-safe slug for a project name, deduped per tenant by the unique index. */
const toSlug = (name: string): string =>
    name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/gu, "-")
        .replaceAll(/(?:^-|-$)/gu, "")
        .slice(0, 60);

/**
 * The dashboard's landing query: the tenant's live project list and the tail of
 * its activity feed, in one subscription. Both reads are inside the caller's
 * shard, so this is one Durable Object round trip, and every connected tab
 * re-renders on any write to either table.
 */
export const overview = query.query(async ({ ctx }): Promise<{ activity: Doc<typeof SAAS_ACTIVITY_TABLE>[]; projects: Doc<typeof SAAS_PROJECTS_TABLE>[] }> => {
    const { organizationId } = requireOrganization(ctx);

    return {
        activity: await ctx.db
            .query(SAAS_ACTIVITY_TABLE)
            .withIndex("byOrgCreatedAt", (q) => q.eq("organizationId", organizationId))
            .order("desc")
            .take(SAAS_ACTIVITY_PAGE),
        projects: await ctx.db
            .query(SAAS_PROJECTS_TABLE)
            .withIndex("byOrg", (q) => q.eq("organizationId", organizationId))
            .collect(),
    };
});

/** The tenant's projects. Archived ones are kept and filtered in the view. */
export const listProjects = query.query(async ({ ctx }): Promise<Doc<typeof SAAS_PROJECTS_TABLE>[]> => {
    const { organizationId } = requireOrganization(ctx);

    return ctx.db
        .query(SAAS_PROJECTS_TABLE)
        .withIndex("byOrg", (q) => q.eq("organizationId", organizationId))
        .collect();
});

/** The tail of the tenant's activity feed. */
export const listActivity = query.query(async ({ ctx }): Promise<Doc<typeof SAAS_ACTIVITY_TABLE>[]> => {
    const { organizationId } = requireOrganization(ctx);

    return ctx.db
        .query(SAAS_ACTIVITY_TABLE)
        .withIndex("byOrgCreatedAt", (q) => q.eq("organizationId", organizationId))
        .order("desc")
        .take(SAAS_ACTIVITY_PAGE);
});

export const createProject = mutation.input({ name: v.string() }).mutation(async ({ args: { name }, ctx }): Promise<Id<typeof SAAS_PROJECTS_TABLE>> => {
    const { organizationId, userId } = requireWriter(ctx);
    const slug = toSlug(name);

    if (!slug) {
        throw new LunoraError("INVALID_ARGUMENT", "name must contain at least one letter or digit");
    }

    // The unique index would reject the duplicate anyway; checking first turns a
    // constraint violation into an error the form can render on the field.
    const clash = await ctx.db
        .query(SAAS_PROJECTS_TABLE)
        .withIndex("byOrgSlug", (q) => q.eq("organizationId", organizationId).eq("slug", slug))
        .first();

    if (clash) {
        throw new LunoraError("ALREADY_EXISTS", `a project named "${name}" already exists`);
    }

    const projectId = await ctx.db.insert(SAAS_PROJECTS_TABLE, { createdBy: userId, name, organizationId, slug });

    await recordActivity(ctx, {
        action: "project.created",
        actorId: userId,
        meta: { name },
        organizationId,
        subjectId: String(projectId),
        subjectType: "project",
    });

    return projectId;
});

export const archiveProject = mutation.input({ projectId: v.id(SAAS_PROJECTS_TABLE) }).mutation(async ({ args: { projectId }, ctx }): Promise<void> => {
    const { organizationId, userId } = requireWriter(ctx);
    const project = await ctx.db.get(projectId);

    // The shard already scopes the read to this tenant; the explicit check is
    // what makes that a guarantee rather than an assumption about the router.
    if (!project || project.organizationId !== organizationId) {
        throw new LunoraError("NOT_FOUND", "project not found");
    }

    if (project.archivedAt) {
        return;
    }

    await ctx.db.patch(projectId, { archivedAt: Date.now() });
    await recordActivity(ctx, {
        action: "project.archived",
        actorId: userId,
        meta: { name: project.name },
        organizationId,
        subjectId: String(projectId),
        subjectType: "project",
    });
});

/**
 * The admin's organisation list — the one read the shard model cannot serve, and
 * the reason `saas_organizations` is `.global()`. Listing tenants by fanning out
 * over every shard is a per-page-view bill; this is one D1 read.
 *
 * Platform-admin only, on better-auth's `admin()` role. Note what it does NOT
 * do: it never reaches into a tenant's shard. An admin who needs one
 * organisation's data impersonates into it (better-auth's impersonation), which
 * keeps every tenant read on the same authorised path as the tenant's own.
 */
export const listOrganizations = query.query(async ({ ctx }): Promise<Doc<typeof SAAS_ORGANIZATIONS_TABLE>[]> => {
    if (!ctx.auth.userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    if (ctx.auth.appRole !== "admin") {
        throw new LunoraError("FORBIDDEN", "requires the platform admin role");
    }

    return ctx.db.query(SAAS_ORGANIZATIONS_TABLE).withIndex("byOrganization").collect();
});

/**
 * Upsert the cross-tenant projection of one organisation. Internal: it is
 * called from the Worker after better-auth reports an organisation created,
 * renamed or resubscribed, never by a client — a client that could write this
 * table could rewrite another tenant's plan.
 */
export const syncOrganization = internalMutation
    .input({ name: v.string(), organizationId: v.string(), plan: v.string(), seats: v.number(), slug: v.string(), status: v.string() })
    .mutation(async ({ args, ctx }): Promise<void> => {
        const existing = await ctx.db
            .query(SAAS_ORGANIZATIONS_TABLE)
            .withIndex("byOrganization", (q) => q.eq("organizationId", args.organizationId))
            .first();

        const row = { ...args, updatedAt: Date.now() };

        if (existing) {
            await ctx.db.patch(existing._id, row);

            return;
        }

        await ctx.db.insert(SAAS_ORGANIZATIONS_TABLE, row);
    });
