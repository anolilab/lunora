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
 * `ratelimit_buckets` table the `ratelimit` item declares.
 *
 * That table is unsharded, so it exists in every shard and the project writes
 * below run on the tenant's shard: the quota is per caller PER ORGANISATION, not
 * per caller overall. Counting across organisations would mean a cross-shard hop,
 * which cannot share the mutation's transaction — and the bucket's read-modify-write
 * is only atomic because it does.
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

    // The caller picks the shard, and `authorizeShard` also admits the root shard
    // that `me` and billing run on. Run anywhere but the tenant's own shard, a
    // read sees none of its rows and a write lands where the dashboard never looks.
    if (ctx.shardKey !== organizationId) {
        throw new LunoraError("FORBIDDEN", "call this on the active organization's shard ({ shardKey: organizationId })");
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
    aggregate: (args: { field: "seats"; op: "sum"; where: OrganizationsWhere }) => Promise<number | null>;
    count: (where: OrganizationsWhere) => Promise<number>;
    findFirst: (args: { where: { organizationId: string } }) => Promise<Doc<"saas_organizations"> | null>;
    findMany: (args: {
        limit?: number;
        orderBy?: Partial<Record<OrganizationSortField, "asc" | "desc">>[];
        where: OrganizationsWhere;
    }) => Promise<{ isDone: boolean; page: Doc<"saas_organizations">[] }>;
}

/** The columns an organisation list is ordered by. */
type OrganizationSortField = "name" | "organizationId" | "plan" | "seats" | "updatedAt";

/**
 * A `where` tree over `saas_organizations`, loose on purpose: the typed tree is
 * the generated one, which this item cannot name (see {@link OrganizationsReader}).
 */
interface OrganizationsWhere {
    [field: string]: unknown;
    AND?: OrganizationsWhere[];
    NOT?: OrganizationsWhere;
    OR?: OrganizationsWhere[];
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
const activityRow = (
    now: number,
    entry: {
        action: string;
        actorId: string;
        meta?: Record<string, unknown>;
        organizationId: string;
        subjectId?: string;
        subjectType: string;
    },
): Record<string, unknown> => ({ ...entry, createdAt: now });

/** Joins an archived project's slug to its id, freeing the slug. `~` never survives {@link toSlug}. */
const ARCHIVED_SLUG_MARK = "~archived~";

/** Replaces the slug of a deleted organisation's projection row, freeing the slug. `~` never occurs in a better-auth slug. */
const DELETED_SLUG_PREFIX = "~deleted~";

const SLUG_MAX_LENGTH = 60;

/** 32-bit FNV-1a, base 36, fixed width — a short stable tag, not a security boundary. */
const slugTag = (text: string): string => {
    let hash = 0x81_1c_9d_c5;

    for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ (text.codePointAt(index) ?? 0), 0x01_00_01_93);
    }

    return (hash >>> 0).toString(36).padStart(7, "0");
};

/**
 * Slug for a project name, deduped per tenant by the unique index. Letters and
 * digits of ANY script survive (NFKC, not NFKD: decomposing would drop the
 * dakuten that tells か from が and merge distinct names). Two cases would
 * otherwise hand the unique index a slug that does not describe the name, so
 * both get a tag derived from the name itself — the same name always yields the
 * same slug, which keeps a real duplicate a CONFLICT:
 *   - a name with no letter or digit at all ("🚀") becomes `project-<tag>`;
 *   - a name longer than the cap keeps its head and gains `-<tag>` of the whole
 *     slug, so two names sharing their first 60 characters stay apart.
 * Returns "" only for a blank name.
 */
const toSlug = (name: string): string => {
    const folded = name.normalize("NFKC").toLowerCase().trim();
    const words = folded.replaceAll(/[^\p{L}\p{M}\p{N}]+/gu, "-").replaceAll(/(?:^-|-$)/gu, "");

    if (folded === "") {
        return "";
    }

    if (words === "") {
        return `project-${slugTag(folded)}`;
    }

    const characters = [...words];

    if (characters.length <= SLUG_MAX_LENGTH) {
        return words;
    }

    const tag = slugTag(words);

    return `${characters
        .slice(0, SLUG_MAX_LENGTH - tag.length - 1)
        .join("")
        .replace(/-+$/u, "")}-${tag}`;
};

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
            throw new LunoraError("VALIDATION_ERROR", "name is required");
        }

        // The unique index would reject the duplicate anyway; checking first turns a
        // constraint violation into an error the form can render on the field.
        const clash = await ctx.db
            .query(SAAS_PROJECTS_TABLE)
            .withIndex("byOrgSlug", (q) => q.eq("organizationId", organizationId).eq("slug", slug))
            .first();

        if (clash && !clash.archivedAt) {
            throw new LunoraError("CONFLICT", `a project named "${name}" already exists`);
        }

        // The unique index covers archived rows too and nothing un-archives, so an
        // archived project would hold its name for good. Archiving releases it:
        // the old row keeps its data under a slug nothing can type.
        if (clash) {
            const clashId = clash["_id"] as Id<"saas_projects">;

            await ctx.db.patch(SAAS_PROJECTS_TABLE, clashId, { slug: `${slug}${ARCHIVED_SLUG_MARK}${String(clashId)}` });
        }

        const projectId = await ctx.db.insert("saas_projects", { createdBy: userId, name, organizationId, slug });

        await ctx.db.insert(
            "saas_activity",
            activityRow(ctx.now, {
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
        const project = await ctx.db.get(SAAS_PROJECTS_TABLE, projectId);

        // The shard gate already confines this call to the caller's own tenant;
        // the explicit check is what makes that a guarantee rather than an
        // assumption about the client having passed the right `shardKey`.
        if (!project || project.organizationId !== organizationId) {
            throw new LunoraError("NOT_FOUND", "project not found");
        }

        if (project.archivedAt) {
            return;
        }

        await ctx.db.patch(SAAS_PROJECTS_TABLE, projectId, { archivedAt: ctx.now });
        await ctx.db.insert(
            "saas_activity",
            activityRow(ctx.now, {
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

/** {@link requireCaller}, and additionally that the caller holds better-auth's platform admin role. */
const requirePlatformAdmin = async (ctx: QueryCtx): Promise<void> => {
    const { appRole } = await requireCaller(ctx);

    if (!hasRole(appRole, PLATFORM_ADMIN_ROLES)) {
        throw new LunoraError("FORBIDDEN", "requires the platform admin role");
    }
};

/** The most organisations one admin page may ask for, whatever `numItems` says. */
const ORGANIZATIONS_PAGE_MAX = 100;

/** The most organisations {@link organizationsById} resolves in one call. */
const ORGANIZATIONS_BY_ID_MAX = 500;

type OrganizationSort = "name" | "plan" | "seats" | "updated";

/**
 * Each sort as a key tuple. Every tuple ends in `organizationId`, which is
 * unique and never changes, so the tuple names exactly one row — the property
 * the keyset cursor below depends on. Two tenants with the same seat count would
 * otherwise straddle a page boundary in an order the database is free to change.
 * The tie-break runs the same way as the key before it, so one index on the
 * tuple (see `schema.ts`) serves the whole order, scanned backwards for `desc`.
 */
const SORT_KEYS: Record<OrganizationSort, ReadonlyArray<{ direction: "asc" | "desc"; field: OrganizationSortField }>> = {
    name: [
        { direction: "asc", field: "name" },
        { direction: "asc", field: "organizationId" },
    ],
    plan: [
        { direction: "asc", field: "plan" },
        { direction: "asc", field: "name" },
        { direction: "asc", field: "organizationId" },
    ],
    seats: [
        { direction: "desc", field: "seats" },
        { direction: "desc", field: "organizationId" },
    ],
    updated: [
        { direction: "desc", field: "updatedAt" },
        { direction: "desc", field: "organizationId" },
    ],
};

/** The filters the list and its totals share, so the header always counts the rows the table pages through. */
const organizationFilterArgs = {
    /** Exact plan id; every plan when omitted. */
    plan: v.optional(v.string().max(64)),
    /** Substring of the name or slug. */
    search: v.optional(v.string().max(100)),
    /** Exact status; every status but `deleted` when omitted. */
    status: v.optional(v.string().max(64)),
};

/**
 * The `where` for a filter. Deleted organisations stay as tombstones (see
 * `syncOrganization`) and are not tenants, so they are excluded whatever the
 * filter says — `status: "deleted"` matches nothing.
 *
 * `contains` is a substring test. On D1 it folds ASCII case only, so "acme"
 * finds "ACME" but "émile" does not find "Émile".
 */
const organizationFilter = ({ plan, search, status }: { plan?: string; search?: string; status?: string }): OrganizationsWhere => {
    const clauses: OrganizationsWhere[] = [{ status: { ne: "deleted" } }];
    const term = search?.trim() ?? "";

    if (status !== undefined) {
        clauses.push({ status });
    }

    if (plan !== undefined) {
        clauses.push({ plan });
    }

    if (term !== "") {
        clauses.push({ OR: [{ name: { contains: term } }, { slug: { contains: term } }] });
    }

    return { AND: clauses };
};

const encodeCursor = (sort: OrganizationSort, row: Doc<"saas_organizations">): string => JSON.stringify(SORT_KEYS[sort].map(({ field }) => row[field]));

const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
};

/** A cursor's key values, checked against the sort it claims to belong to. A cursor is client-held, so it is input. */
const decodeCursor = (sort: OrganizationSort, cursor: string): unknown[] => {
    const keys = SORT_KEYS[sort];
    const values = parseJson(cursor);

    if (
        !Array.isArray(values) ||
        values.length !== keys.length ||
        !keys.every(({ field }, index) => typeof values[index] === (field === "seats" || field === "updatedAt" ? "number" : "string"))
    ) {
        throw new LunoraError("VALIDATION_ERROR", "invalid organization cursor");
    }

    return values;
};

/**
 * Rows strictly after `values` in the sort's order: the first key past its
 * value, or equal on it and past on the next, and so on down the tuple.
 */
const after = (sort: OrganizationSort, values: unknown[]): OrganizationsWhere => {
    const keys = SORT_KEYS[sort];

    return {
        OR: keys.map(({ direction, field }, index) => {
            return {
                AND: [
                    ...keys.slice(0, index).map((key, equalIndex) => {
                        return { [key.field]: values[equalIndex] };
                    }),
                    { [field]: direction === "asc" ? { gt: values[index] } : { lt: values[index] } },
                ],
            };
        }),
    };
};

const pageCursor = v.optional(v.union(v.string(), v.null()));

/**
 * The admin's organisation list, a page at a time — the one read the shard
 * model cannot serve, and the reason `saas_organizations` is `.global()`.
 * Listing tenants by fanning out over every shard is a per-page-view bill; this
 * is one D1 read.
 *
 * Search, filters and sort run here, not over the rows a browser happens to
 * have loaded, so the first page is the first page of the whole filtered set.
 * The header's figures come from {@link organizationTotals} with the same
 * filter.
 *
 * Paged for `usePaginatedQuery`, which re-reads each loaded page as the fixed
 * range `(cursor, endCursor]` so a live insert grows one page instead of
 * shifting a row across a boundary. `findMany` on D1 has no `endCursor`, so the
 * cursor is minted here: the sort's key tuple of the last row, bounded in
 * `where`. `numItems` is capped rather than trusted, so a caller cannot ask for
 * the whole table in one page.
 *
 * Platform-admin only, on better-auth's `admin()` role. Note what it does NOT
 * do: it never reaches into a tenant's shard. An admin who needs one
 * organisation's data impersonates into it (better-auth's impersonation), which
 * keeps every tenant read on the same authorised path as the tenant's own.
 */
export const listOrganizations = query
    .input({
        ...organizationFilterArgs,
        paginationOpts: v.object({ cursor: pageCursor, endCursor: pageCursor, numItems: v.number() }),
        /** `updated` (newest first) when omitted. */
        sort: v.optional(v.union(v.literal("name"), v.literal("plan"), v.literal("seats"), v.literal("updated"))),
    })
    .query(
        async ({
            args: { paginationOpts, sort = "updated", ...filter },
            ctx,
        }): Promise<{ continueCursor: string | null; isDone: boolean; page: Doc<"saas_organizations">[]; splitCursor?: string | null }> => {
            await requirePlatformAdmin(ctx);

            const { cursor, endCursor } = paginationOpts;
            const clauses = [organizationFilter(filter)];

            if (cursor) {
                clauses.push(after(sort, decodeCursor(sort, cursor)));
            }

            if (endCursor) {
                clauses.push({ NOT: after(sort, decodeCursor(sort, endCursor)) });
            }

            const where = { AND: clauses };
            const orderBy = SORT_KEYS[sort].map(({ direction, field }) => {
                return { [field]: direction };
            });

            if (endCursor) {
                // A bounded page is the whole range however it has grown; the
                // midpoint lets the client split one that has grown too far.
                const { page } = await organizations(ctx).findMany({ orderBy, where });
                const middle = page.length >= 2 ? page[Math.floor(page.length / 2) - 1] : undefined;

                return { continueCursor: endCursor, isDone: true, page, splitCursor: middle ? encodeCursor(sort, middle) : null };
            }

            const numItems = Math.min(Math.max(Math.floor(paginationOpts.numItems), 1), ORGANIZATIONS_PAGE_MAX);
            const { isDone, page } = await organizations(ctx).findMany({ limit: numItems, orderBy, where });
            const last = page.at(-1);

            return { continueCursor: isDone || !last ? null : encodeCursor(sort, last), isDone, page };
        },
    );

/**
 * The organisation list's header figures over the same filter as
 * {@link listOrganizations}: how many organisations match, and their seats. A
 * live count and sum in D1, so they cover the whole filtered set, not the pages
 * loaded so far.
 */
export const organizationTotals = query.input(organizationFilterArgs).query(async ({ args, ctx }): Promise<{ organizations: number; seats: number }> => {
    await requirePlatformAdmin(ctx);

    const where = organizationFilter(args);
    const [count, seats] = await Promise.all([organizations(ctx).count(where), organizations(ctx).aggregate({ field: "seats", op: "sum", where })]);

    return { organizations: count, seats: seats ?? 0 };
});

/**
 * The projection rows for these organisation ids — how a cross-tenant screen
 * names the tenants it lists (the admin's subscription table) now that the
 * organisation list is paged and no longer holds every name. Deleted
 * organisations are left out, as they are from the list.
 */
export const organizationsById = query
    .input({ organizationIds: v.array(v.string().max(256)).max(ORGANIZATIONS_BY_ID_MAX) })
    .query(async ({ args: { organizationIds }, ctx }): Promise<Doc<"saas_organizations">[]> => {
        await requirePlatformAdmin(ctx);

        if (organizationIds.length === 0) {
            return [];
        }

        const { page } = await organizations(ctx).findMany({ where: { organizationId: { in: [...new Set(organizationIds)] }, status: { ne: "deleted" } } });

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
 *
 * A deleted organisation is kept as a tombstone, not removed: a member hook still
 * in flight when the deletion lands would otherwise re-insert the row as active.
 * The tombstone gives its slug back — `bySlug` is unique, and better-auth lets the
 * next organisation take it — and is final, so a late sync cannot revive it. It is
 * written even for an organisation never projected: the hooks run concurrently, so
 * the deletion can land before the creation it follows.
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
        const updatedAt = ctx.now;

        if (existing?.["status"] === "deleted") {
            return;
        }

        if (status === "deleted") {
            const slug = `${DELETED_SLUG_PREFIX}${organizationId}`;

            if (existing) {
                await ctx.db.patch(SAAS_ORGANIZATIONS_TABLE, existing["_id"] as Id<"saas_organizations">, { slug, status, updatedAt });
            } else {
                await ctx.db.insert("saas_organizations", { name, organizationId, plan: plan ?? "free", seats: seats ?? 0, slug, status, updatedAt });
            }

            return;
        }

        if (existing) {
            // `_id` through the index signature, and named as the id it is: a row
            // read from `ctx.db` is `Doc<"saas_organizations">` in your project,
            // where this cast is the identity. The item itself compiles against the
            // base, table-generic context, which cannot know that.
            await ctx.db.patch(SAAS_ORGANIZATIONS_TABLE, existing["_id"] as Id<"saas_organizations">, {
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
