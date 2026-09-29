/**
 * SaaS kit functions — added by `lunora registry add saas`.
 *
 * This file is YOURS: a normal Lunora module copied into your project. Re-export
 * it from your `lunora/` entry so codegen picks it up — the functions surface in
 * the generated `api` as `saas/me`, `saas/overview`, and so on.
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
import { RateLimiter, createDbStore, rateLimit } from "lunorash/ratelimit";

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
 *
 * Generic in the context rather than annotated `MutationCtx`: `rateLimit` infers
 * its `Context` from the options object, so naming a concrete context here pins
 * that inference to THIS module's view of it and every handler downstream of the
 * middleware degrades to `unknown`. Taking only the two fields the key reads keeps
 * the helper shared across query and mutation without pinning anything.
 */
const byCaller = <TContext extends { auth: { userId?: string | null }; ip?: string | undefined }>(ctx: TContext): string => ctx.auth.userId ?? ctx.ip ?? "anon";

/*
 * Table names appear as literals in every TYPE position below, never as
 * `typeof SAAS_PROJECTS_TABLE`. Codegen copies a function's declared return
 * type verbatim into `_generated/api.ts`, where these constants are not in
 * scope — a `typeof` there compiles here and breaks the generated client.
 */

/** Roles allowed to change an organisation's projects. better-auth's defaults. */
const WRITER_ROLES = new Set(["admin", "owner"]);

/** The platform-wide role `listOrganizations` requires — better-auth `admin()`'s default. */
const PLATFORM_ADMIN_ROLES = new Set(["admin"]);

/**
 * Read one declared claim as a non-empty string.
 *
 * `ctx.auth.getIdentity()` is typed by the consumer's `lunora/identity.ts`, so in a
 * scaffolded project these claims are already strings. The item cannot assume that:
 * it compiles against the base contract (`Record<string, unknown> | null`), and a
 * project that has not wired `identity.ts` still installs it. Checking here rather
 * than asserting means the tenancy decisions below rest on a value this module has
 * actually seen be a string — which is the right posture for the claims that decide
 * which organisation's data a caller reaches.
 */
const claim = (identity: Record<string, unknown>, name: string): string | undefined => {
    const value = identity[name];

    return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * Whether a role claim grants one of `allowed`. better-auth stores several roles
 * comma-joined (`"admin,owner"`) — both `admin()`'s `user.role` and the
 * organization plugin's `member.role` — so an exact comparison denies a caller
 * who holds the role alongside another.
 */
const hasRole = (value: string | undefined, allowed: ReadonlySet<string>): boolean => value?.split(",").some((role) => allowed.has(role.trim())) ?? false;

/** The verified caller, as far as the identity carries them. */
interface Caller {
    appRole?: string;
    name?: string;
    organizationId?: string;
    orgRole?: string;
    userId: string;
}

/**
 * The caller's claims, or `null` when nobody is signed in.
 *
 * `userId` is the flat `ctx.auth.userId` and NOT one of the claims: the runtime
 * forwards it separately and strips it from what `ctx.auth.getIdentity()`
 * returns (which is `null` when no other claim was resolved). Every other
 * declared claim comes through `getIdentity()` — the contract in
 * `lunora/identity.ts` types that call's result, so reaching for
 * `ctx.auth.activeOrganizationId` does not compile, which is the type system
 * keeping the trust boundary honest.
 */
const readCaller = async (ctx: MutationCtx | QueryCtx): Promise<Caller | null> => {
    const { userId } = ctx.auth;

    if (!userId) {
        return null;
    }

    const identity: Record<string, unknown> = (await ctx.auth.getIdentity()) ?? {};

    return {
        appRole: claim(identity, "appRole"),
        name: claim(identity, "name"),
        organizationId: claim(identity, "activeOrganizationId"),
        orgRole: claim(identity, "orgRole"),
        userId,
    };
};

/** {@link readCaller}, throwing `UNAUTHORIZED` for an anonymous caller. */
const requireCaller = async (ctx: MutationCtx | QueryCtx): Promise<Caller> => {
    const caller = await readCaller(ctx);

    if (caller === null) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    return caller;
};

/**
 * The caller's verified user id, tenant and role in it, or a thrown error.
 *
 * Callers get `UNAUTHORIZED` with no session and `UNPROCESSABLE` with a
 * session but no organisation — different screens (sign in vs. create your
 * first organisation), so they must not collapse into one code.
 */
const requireOrganization = async (ctx: MutationCtx | QueryCtx): Promise<{ organizationId: string; orgRole?: string; userId: string }> => {
    const { organizationId, orgRole, userId } = await requireCaller(ctx);

    if (organizationId === undefined) {
        throw new LunoraError("UNPROCESSABLE", "no active organization — create or switch to one first");
    }

    return { organizationId, orgRole, userId };
};

/** As {@link requireOrganization}, and additionally that the caller may write. */
const requireWriter = async (ctx: MutationCtx): Promise<{ organizationId: string; userId: string }> => {
    const { organizationId, orgRole, userId } = await requireOrganization(ctx);

    if (!hasRole(orgRole, WRITER_ROLES)) {
        throw new LunoraError("FORBIDDEN", "requires the admin or owner role in this organization");
    }

    return { organizationId, userId };
};

/**
 * The `saas_organizations` reader. The table is `.global()`, so it is served
 * from D1, whose backend has no `query().withIndex()` reader — a call through
 * one throws INTERNAL at runtime — only the per-table facade
 * (`ctx.db.saas_organizations.findFirst` / `findMany`).
 *
 * This item compiles against the base context, which declares no per-table
 * facades, so the two methods it uses are named here. In your project
 * `ctx.db.saas_organizations` is the generated, typed accessor, and this is the
 * one place that reaches it structurally.
 */
interface OrganizationsReader {
    findFirst: (args: { where: { organizationId: string } }) => Promise<Doc<"saas_organizations"> | null>;
    findMany: (args: Record<string, never>) => Promise<{ page: Doc<"saas_organizations">[] }>;
}

const organizations = (ctx: MutationCtx | QueryCtx): OrganizationsReader =>
    (ctx.db as unknown as Record<typeof SAAS_ORGANIZATIONS_TABLE, OrganizationsReader>)[SAAS_ORGANIZATIONS_TABLE];

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
 * Who the caller is, for the client to route with — run it on the ROOT shard
 * (no `shardKey`), which every signed-in caller may enter.
 *
 * The client needs `organizationId` before it can subscribe to anything else:
 * it is the shard key every org-scoped call below must carry, and the shard
 * gate (`authorizeShard` in the Worker) admits a caller to that shard only. So
 * this is the one read that cannot itself be tenant-sharded. `seats` is the
 * member count off the `.global()` projection, for the billing page's meter.
 *
 * `null` when nobody is signed in, rather than a thrown `UNAUTHORIZED`: "show
 * the sign-in link" is a state of the page, not an error. (Behind the kit's
 * `authorizeShard`, which turns anonymous callers away from every shard, a
 * signed-out client sees the shard refusal before this runs.)
 */
export const me = query.query(async ({ ctx }): Promise<{ name?: string; organizationId?: string; orgRole?: string; seats?: number; userId: string } | null> => {
    const caller = await readCaller(ctx);

    if (caller === null) {
        return null;
    }

    const { name, organizationId, orgRole, userId } = caller;
    const organization = organizationId === undefined ? null : await organizations(ctx).findFirst({ where: { organizationId } });
    const seats = organization?.["seats"];

    return { name, organizationId, orgRole, seats: typeof seats === "number" ? seats : undefined, userId };
});

/**
 * The dashboard's landing query: the tenant's live project list and the tail of
 * its activity feed, in one subscription. Call it with
 * `{ shardKey: organizationId }` (from {@link me}) — both tables are sharded by
 * it, so the reads are inside the tenant's own Durable Object: one round trip,
 * and every connected tab re-renders on any write to either table.
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

export const createProject = mutation
    .input({ name: v.string().max(120) })
    .use(rateLimit(limiter, "project", { key: byCaller }))
    .mutation(async ({ args: { name }, ctx }): Promise<Id<"saas_projects">> => {
        const { organizationId, userId } = await requireWriter(ctx);
        const slug = toSlug(name);

        if (!slug) {
            throw new LunoraError("VALIDATION_ERROR", "name must contain at least one letter or digit");
        }

        // The unique index would reject the duplicate anyway; checking first turns a
        // constraint violation into an error the form can render on the field.
        const clash = await ctx.db
            .query(SAAS_PROJECTS_TABLE)
            .withIndex("byOrgSlug", (q) => q.eq("organizationId", organizationId).eq("slug", slug))
            .first();

        if (clash) {
            throw new LunoraError("CONFLICT", `a project named "${name}" already exists`);
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
    .use(rateLimit(limiter, "project", { key: byCaller }))
    .mutation(async ({ args: { projectId }, ctx }): Promise<void> => {
        const { organizationId, userId } = await requireWriter(ctx);
        const project = await ctx.db.get(projectId);

        // The shard gate already confines this call to the caller's own tenant;
        // the explicit check is what makes that a guarantee rather than an
        // assumption about the client having passed the right `shardKey`.
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
    const { appRole } = await requireCaller(ctx);

    if (!hasRole(appRole, PLATFORM_ADMIN_ROLES)) {
        throw new LunoraError("FORBIDDEN", "requires the platform admin role");
    }

    // ponytail: the first page only — page through `cursor` once there are more
    // tenants than one page holds.
    const { page } = await organizations(ctx).findMany({});

    return page;
});

/**
 * Upsert the cross-tenant projection of one organisation. Internal: the Worker
 * calls it from better-auth's organization hooks (see `lunora/auth/index.ts`)
 * when an organisation is created, renamed or deleted, or gains or loses a
 * member — never a client, because a client that could write this table could
 * rewrite another tenant's plan.
 *
 * `name` and `slug` ride on every call so the first sync of an organisation that
 * predates the hooks still inserts a whole row. The rest are patched only when
 * given, so a membership change cannot reset a plan. A new row starts on the
 * `free` plan — the catalog's id for "no subscription".
 */
export const syncOrganization = internalMutation
    .input({
        name: v.string(),
        organizationId: v.string(),
        plan: v.optional(v.string()),
        seats: v.optional(v.number()),
        slug: v.string(),
        status: v.optional(v.string()),
    })
    .mutation(async ({ args: { name, organizationId, plan, seats, slug, status }, ctx }): Promise<void> => {
        const existing = await organizations(ctx).findFirst({ where: { organizationId } });
        const updatedAt = Date.now();

        if (existing) {
            // `_id` through the index signature, and named as the id it is: a row
            // read from `ctx.db` is `Doc<"saas_organizations">` in your project,
            // where this cast is the identity. The item itself compiles against the
            // base, table-generic context, which cannot know that.
            await ctx.db.patch(existing["_id"] as Id<"saas_organizations">, {
                name,
                slug,
                updatedAt,
                ...(plan === undefined ? {} : { plan }),
                ...(seats === undefined ? {} : { seats }),
                ...(status === undefined ? {} : { status }),
            });

            return;
        }

        await ctx.db.insert("saas_organizations", {
            name,
            organizationId,
            plan: plan ?? "free",
            seats: seats ?? 1,
            slug,
            status: status ?? "active",
            updatedAt,
        });
    });
