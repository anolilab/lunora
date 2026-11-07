import { agentExtension } from "@lunora/agent";
import { paymentExtension } from "@lunora/payment";
import { defineSchema, defineTable, v } from "lunorash/server";

import { domains } from "./domains/schema";
// lunora:add:presence:start
import { presence } from "./presence/schema";
// lunora:add:presence:end
// lunora:add:ratelimit:start
import { ratelimit } from "./ratelimit/schema";
// lunora:add:ratelimit:end
// lunora:add:saas:start
import { saas } from "./saas/schema";
// lunora:add:saas:end

/**
 * Your tables go in the `defineSchema({ … })` call; the kit's arrive through the
 * managed `.extend()` blocks below, which `lunora registry add` maintains.
 *
 * The default export is load-bearing — codegen's generated `app.ts` and
 * `shard.ts` import this module's default.
 */
export default defineSchema({
    /*
     * One row per organisation with a checkout in flight — see `checkout` in
     * `lunora/payment/index.ts`. Root-scoped like the payment tables it guards,
     * and taken inside a mutation, because only a mutation serialises two
     * concurrent purchases; the provider call itself cannot.
     */
    /** Organisations whose subscription cancellation after deletion is still owed (see `payment:sweepPendingCancels`). */
    billing_pending: defineTable({
        organizationId: v.string(),
        /** When the sweep last tried this cancellation; the oldest is tried first, so a failing row cannot hold up the rest. */
        tried: v.number(),
    })
        .index("byOrganization", ["organizationId"])
        .index("byTried", ["tried"]),

    checkout_holds: defineTable({
        expiresAt: v.number(),
        priceId: v.string(),
        referenceId: v.string(),
        url: v.optional(v.string()),
    }).index("byReference", ["referenceId"], { unique: true }),

    /*
     * One row per pending invitation, holding the seat it would take — see
     * `lunora/seats.ts`. Taken inside a mutation for the same reason as a checkout
     * hold: only a mutation serialises two invitations racing for the last seat.
     */
    invitation_holds: defineTable({
        email: v.string(),
        expiresAt: v.number(),
        organizationId: v.string(),
    })
        .index("byOrganizationEmail", ["organizationId", "email"], { unique: true })
        .index("byOrganizationExpiry", ["organizationId", "expiresAt"]),

    /** Per-tenant work items — the core CRUD surface the bench exercises. */
    tasks: defineTable({
        assigneeId: v.optional(v.string()),
        createdAt: v.number(),
        createdBy: v.string(),
        description: v.optional(v.string()),
        dueAt: v.optional(v.number()),
        estimate: v.optional(v.number()),
        labels: v.array(v.string()),
        organizationId: v.string(),
        priority: v.union(v.literal("low"), v.literal("normal"), v.literal("high"), v.literal("urgent")),
        /** Written only by the onboarding seed, which the nudge count leaves out. Not in any caller's validator. */
        starter: v.optional(v.boolean()),
        projectId: v.optional(v.id("saas_projects")),
        status: v.union(v.literal("todo"), v.literal("doing"), v.literal("review"), v.literal("done"), v.literal("archived")),
        title: v.string(),
        updatedAt: v.number(),
    })
        .shardBy("organizationId")
        .index("byOrgStatus", ["organizationId", "status", "updatedAt"])
        // The unfiltered list: newest first across every status, which byOrgStatus cannot give.
        .index("byOrgUpdated", ["organizationId", "updatedAt"])
        .index("byOrgAssignee", ["organizationId", "assigneeId", "dueAt"])
        .index("byOrgProject", ["organizationId", "projectId", "createdAt"])
        .searchIndex("search_title", { filterFields: ["organizationId", "status"], field: "title" })
        // Trigger-maintained counters, so the headline counts every task without scanning them.
        .aggregateIndex("countByOrgStatus", { by: ["organizationId", "status"] }),

    taskComments: defineTable({
        authorId: v.string(),
        body: v.string(),
        createdAt: v.number(),
        editedAt: v.optional(v.number()),
        organizationId: v.string(),
        taskId: v.id("tasks"),
    })
        .shardBy("organizationId")
        .index("byTask", ["organizationId", "taskId", "createdAt"]),

    /** The in-app notification feed, written by the `events` queue consumer. */
    notifications: defineTable({
        createdAt: v.number(),
        kind: v.string(),
        organizationId: v.string(),
        readAt: v.optional(v.number()),
        subjectId: v.optional(v.string()),
    })
        .shardBy("organizationId")
        .index("byOrgCreatedAt", ["organizationId", "createdAt"]),
})
    // The durable agent's thread + message tables (`agent_threads`, `agent_messages`).
    .extend(agentExtension)
    /*
     * The payment store's tables, as the package's own schema extension: the store
     * reads and writes them as `payment_customers`, `payment_sessions`,
     * `payment_subscriptions`, … — names, columns and indexes that live in
     * `@lunora/payment`, so an upgrade brings a new column with no edit here.
     * Copying them inline instead drifts from what the store writes, and a
     * column type that disagrees (money is stored as numbers) fails every
     * payment write.
     *
     * They are root-scoped rather than `.shardBy("referenceId")`, and that is a
     * deliberate asymmetry with the rest of this app. A provider webhook arrives
     * with no session and no tenant — there is nothing to resolve a shard from —
     * so billing rows live at the root and carry the tenant in `referenceId`
     * instead. The organization id goes in that field (see `lunora/server.ts`),
     * which is what keeps a subscription tenant-scoped logically even though it
     * is not tenant-sharded physically.
     */
    .extend(paymentExtension)
    // lunora:add:ratelimit:start
    .extend(ratelimit.extension)
    // lunora:add:ratelimit:end
    // lunora:add:saas:start
    .extend(saas.extension)
    // lunora:add:saas:end
    // lunora:add:presence:start
    .extend(presence.extension)
    // lunora:add:presence:end
    // The generated bench domains (empty in the committed, core-only state).
    .extend(domains.extension);
