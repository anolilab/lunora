/**
 * SaaS kit schema extension — added by `lunora registry add saas`.
 *
 * This is the tenant model the kit is built on, and the one decision that is
 * not portable to any other stack: **a tenant is a shard**. `projects` and
 * `activity` are `.shardBy("organizationId")`, so one organisation's data lives
 * in one Durable Object. Isolation, per-tenant OCC and per-tenant reactive
 * fan-out are consequences of that line rather than things the app has to
 * enforce — there is no `WHERE organizationId = ?` to forget.
 *
 * The cost is stated up front, because it shapes every admin screen: a query
 * runs inside ONE shard, so nothing here can list across organisations. That is
 * what `organizations` is for. It is `.global()` (D1-backed), a projection of
 * the identity records better-auth owns, and it exists for exactly two reads
 * the shard model cannot serve:
 *
 *   1. The admin's cross-organisation lists (workstream G) — a fan-out over
 *      every shard per page view is not a design, it is a bill.
 *   2. Resolving an organisation *before* you know which shard to enter — slug
 *      lookups, the org switcher, seat counts on a billing page.
 *
 * It is a projection, never a source of truth: users, organisations, members
 * and invitations live in better-auth's D1 tables, which are not Lunora tables
 * and cannot be read through `ctx.db`. `syncOrganization` in `./index.ts` is
 * what keeps the two in step; if the projection is stale, better-auth wins.
 *
 * This file is YOURS to own and edit. `lunora registry add` splices a managed
 * `.extend(saas.extension)` into `lunora/schema.ts`, so the bare table names
 * below merge as `saas_projects`, `saas_activity` and `saas_organizations` —
 * extension tables are auto-prefixed with the plugin key. Write the bare name
 * here and reference the merged name through the constants.
 */
import { definePlugin, defineSchemaExtension, defineTable, v } from "lunorash/server";

/** Merged name of the per-tenant `projects` table. */
export const SAAS_PROJECTS_TABLE = "saas_projects";

/** Merged name of the per-tenant `activity` table. */
export const SAAS_ACTIVITY_TABLE = "saas_activity";

/** Merged name of the cross-tenant `organizations` projection. */
export const SAAS_ORGANIZATIONS_TABLE = "saas_organizations";

/**
 * How many activity rows a dashboard feed reads. The feed is a live query, so
 * this is the size of what every connected tab re-receives on each write —
 * raise it and you widen every subscriber's payload, not just the first page.
 */
export const SAAS_ACTIVITY_PAGE = 50;

/**
 * The SaaS kit plugin. `lunora/schema.ts` wires it in through the managed
 * `.extend(saas.extension)` block that `registry add` splices.
 */
export const saas = definePlugin("saas", {
    extension: defineSchemaExtension("saas", {
        tables: {
            /**
             * The per-tenant activity feed — the dashboard's live surface and
             * the audit trail an admin reads. Written only by `recordActivity`,
             * inside the same mutation as the change it describes, so a feed
             * entry cannot survive a rolled-back write.
             */
            activity: defineTable({
                action: v.string(),
                actorId: v.string(),
                createdAt: v.number(),
                meta: v.optional(v.record(v.string(), v.any())),
                organizationId: v.string(),
                subjectId: v.optional(v.string()),
                subjectType: v.string(),
            })
                .shardBy("organizationId")
                // `createdAt` trails the equality column so the feed reads as a
                // descending range rather than a sort over a collected set.
                .index("byOrgCreatedAt", ["organizationId", "createdAt"]),

            /**
             * The demo resource the dashboard manages. Replace it with whatever
             * your product actually is — it is here so the kit ships a working
             * CRUD surface (table, form, optimistic write, live update) rather
             * than an empty shell, and so the tenancy model has something to
             * demonstrate.
             */
            projects: defineTable({
                archivedAt: v.optional(v.number()),
                createdBy: v.string(),
                name: v.string(),
                organizationId: v.string(),
                slug: v.string(),
            })
                .shardBy("organizationId")
                // One index, not two: `byOrgSlug`'s leading `organizationId`
                // already serves the per-tenant list, so a separate `byOrg`
                // would be a redundant prefix — `@lunora/advisor` reports it as
                // `duplicate_index`.
                //
                // Unique per tenant rather than globally: two organisations may
                // both have a `website` project, and the shard makes that safe.
                .index("byOrgSlug", ["organizationId", "slug"], { unique: true }),

            /**
             * Cross-tenant projection of better-auth's organisations. `.global()`
             * because its whole purpose is the reads a shard cannot serve — see
             * the module docstring. Keep it narrow: every column here is one
             * more thing that can drift from the record that owns it.
             */
            organizations: defineTable({
                name: v.string(),
                organizationId: v.string(),
                plan: v.string(),
                seats: v.number(),
                slug: v.string(),
                status: v.string(),
                updatedAt: v.number(),
            })
                .global()
                .index("byOrganization", ["organizationId"], { unique: true })
                .index("byPlan", ["plan"])
                .index("bySlug", ["slug"], { unique: true }),
        },
    }),
});
