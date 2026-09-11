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
 *      org-scoped function resolves the tenant from the declared
 *      `activeOrganizationId` claim (`lunora/identity.ts`, validated at the
 *      trust boundary) through `ctx.auth.getIdentity()`. An `organizationId`
 *      input would be a tenant-escape bug with a type annotation on it.
 *   2. **A write and the activity row that describes it share one mutation.**
 *      The activity insert sits in the handler beside the change it records, so
 *      it joins the same transaction: if the write rolls back, the feed entry
 *      goes with it. An activity log that can outlive its event is worse than
 *      none.
 */
import { LunoraError } from "@lunora/errors";
import { RateLimiter, createDbStore } from "lunorash/ratelimit";
import { rateLimit } from "lunorash/ratelimit";

import type { Doc, Id, MutationCtx, QueryCtx } from "#lunora/_generated/server.js";
import { internalMutation, mutation, query, v } from "#lunora/_generated/server.js";

import { SAAS_ACTIVITY_PAGE, SAAS_ACTIVITY_TABLE, SAAS_ORGANIZATIONS_TABLE, SAAS_PROJECTS_TABLE } from "./schema.js";

/**
 * The kit's own limit config, rather than the `limits` map in
 * `lunora/ratelimit/schema.ts`: that file is yours, and an item that reached
 * into it would break the moment you renamed a bucket. Both share the durable
 * `ratelimit_buckets` table the `ratelimit` item declares, so the state is one
 * store either way.
 */
const saasLimits = {
    /** Project writes: 20 per caller per minute — generous for a human, useless for a script. */
    project: { kind: "token bucket", period: 60_000, rate: 20 },
} as const;

const limiter = (ctx: MutationCtx): RateLimiter<keyof typeof saasLimits> =>
    new RateLimiter<keyof typeof saasLimits>({
        config: saasLimits,
        store: createDbStore({ db: ctx.db as never, table: "ratelimit_buckets" }),
    });

/**
 * Key every bucket on the server-trusted caller, never on anything from `args`
 * — an argument-derived key is one a caller rotates per request to get a fresh
 * bucket each time, which is a rate limit that reads as one and is not one.
 */
const byCaller = { key: (ctx: MutationCtx): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

/**
 * Table names appear as literals in every TYPE position below, never as
 * `typeof SAAS_PROJECTS_TABLE`. Codegen copies a function's declared return
 * type verbatim into `_generated/api.ts`, where these constants are not in
 * scope — a `typeof` there compiles here and breaks the generated client.
 */
/** Roles allowed to change an organisation's projects. better-auth's defaults. */
const WRITER_ROLES = new Set(["admin", "owner"]);

/**
 * The caller's verified user id and tenant, or a thrown error.
 *
 * Declared claims resolve through `ctx.auth.getIdentity()` — the contract in
 * `lunora/identity.ts` types that call's result. Only `userId` is also a flat
 * property on `ctx.auth`; reaching for `ctx.auth.activeOrganizationId` does not
 * compile, which is the type system keeping the trust boundary honest.
 *
 * Callers get `UNAUTHORIZED` with no session and `FAILED_PRECONDITION` with a
 * session but no organisation — different screens (sign in vs. create your
 * first organisation), so they must not collapse into one code.
 */
const requireOrganization = async (ctx: MutationCtx | QueryCtx): Promise<{ organizationId: string; userId: string }> => {
    const identity = await ctx.auth.getIdentity();

    if (!identity) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    if (!identity.activeOrganizationId) {
        throw new LunoraError("FAILED_PRECONDITION", "no active organization — create or switch to one first");
    }

    return { organizationId: identity.activeOrganizationId, userId: identity.userId };
};

/** As {@link requireOrganization}, and additionally that the caller may write. */
const requireWriter = async (ctx: MutationCtx): Promise<{ organizationId: string; userId: string }> => {
    const scope = await requireOrganization(ctx);
    const identity = await ctx.auth.getIdentity();

    if (!WRITER_ROLES.has(identity?.orgRole ?? "member")) {
        throw new LunoraError("FORBIDDEN", "requires the admin or owner role in this organization");
    }

    return scope;
};

/**
 * Build an activity row. A row builder rather than a writer, because the insert
 * has to happen in the *caller's* handler for two reasons: it keeps the feed
 * entry inside the same transaction as the change it describes (a helper that
 * called `runMutation` would give it its own, and a feed entry that can outlive
 * its event is worse than none), and codegen discovers a table's write path by
 * matching `ctx.db.insert("<table>", …)` inside a procedure — an insert hidden
 * behind a helper is reported as `table_without_insert`.
 */
const activityRow = (entry: {
    action: string;
    actorId: string;
    meta?: Record<string, unknown>;
    organizationId: string;
    subjectId?: string;
    subjectType: string;
}): Record<string, unknown> => ({ ...entry, createdAt: Date.now() });

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
export const overview = query.query(async ({ ctx }): Promise<{ activity: Doc<"saas_activity">[]; projects: Doc<"saas_projects">[] }> => {
    const { organizationId } = await requireOrganization(ctx);

    return {
        activity: await ctx.db
            .query(SAAS_ACTIVITY_TABLE)
            .withIndex("byOrgCreatedAt", (q) => q.eq("organizationId", organizationId))
            .order("desc")
            .take(SAAS_ACTIVITY_PAGE),
        projects: await ctx.db
            .query(SAAS_PROJECTS_TABLE)
            .withIndex("byOrgSlug", (q) => q.eq("organizationId", organizationId))
            .collect(),
    };
});

/** The tenant's projects. Archived ones are kept and filtered in the view. */
export const listProjects = query.query(async ({ ctx }): Promise<Doc<"saas_projects">[]> => {
    const { organizationId } = await requireOrganization(ctx);

    return ctx.db
        .query(SAAS_PROJECTS_TABLE)
        .withIndex("byOrgSlug", (q) => q.eq("organizationId", organizationId))
        .collect();
});

/** The tail of the tenant's activity feed. */
export const listActivity = query.query(async ({ ctx }): Promise<Doc<"saas_activity">[]> => {
    const { organizationId } = await requireOrganization(ctx);

    return ctx.db
        .query(SAAS_ACTIVITY_TABLE)
        .withIndex("byOrgCreatedAt", (q) => q.eq("organizationId", organizationId))
        .order("desc")
        .take(SAAS_ACTIVITY_PAGE);
});

export const createProject = mutation
    .input({ name: v.string().max(120) })
    .use(rateLimit(limiter, "project", byCaller))
    .mutation(async ({ args: { name }, ctx }): Promise<Id<"saas_projects">> => {
        const { organizationId, userId } = await requireWriter(ctx);
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

        const projectId = await ctx.db.insert("saas_projects", { createdBy: userId, name, organizationId, slug });

        await ctx.db.insert(
            "saas_activity",
            activityRow({
                action: "project.created",
                actorId: userId,
                meta: { name },
                organizationId,
                subjectId: String(projectId),
                subjectType: "project",
            }),
        );

        ctx.log.info("project.created", { organizationId, project: String(projectId) });

        return projectId;
    });

// The FK target is spelled as a literal, not `SAAS_PROJECTS_TABLE`: codegen
// resolves `v.id(...)` targets statically from the AST, so a constant here is
// a hard codegen error. Runtime table reads (`ctx.db.query(...)`) take the
// constant — only the validator needs the literal.
export const archiveProject = mutation
    .input({ projectId: v.id("saas_projects") })
    .use(rateLimit(limiter, "project", byCaller))
    .mutation(async ({ args: { projectId }, ctx }): Promise<void> => {
        const { organizationId, userId } = await requireWriter(ctx);
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
        await ctx.db.insert(
            "saas_activity",
            activityRow({
                action: "project.archived",
                actorId: userId,
                meta: { name: project.name },
                organizationId,
                subjectId: String(projectId),
                subjectType: "project",
            }),
        );

        ctx.log.info("project.archived", { organizationId, project: String(projectId) });
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
export const listOrganizations = query.query(async ({ ctx }): Promise<Doc<"saas_organizations">[]> => {
    const identity = await ctx.auth.getIdentity();

    if (!identity) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    if (identity.appRole !== "admin") {
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

        await ctx.db.insert("saas_organizations", row);
    });
