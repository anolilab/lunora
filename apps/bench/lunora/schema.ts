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
        projectId: v.optional(v.id("saas_projects")),
        status: v.union(v.literal("todo"), v.literal("doing"), v.literal("review"), v.literal("done"), v.literal("archived")),
        title: v.string(),
        updatedAt: v.number(),
    })
        .shardBy("organizationId")
        .index("byOrgStatus", ["organizationId", "status", "updatedAt"])
        .index("byOrgAssignee", ["organizationId", "assigneeId", "dueAt"])
        .index("byOrgProject", ["organizationId", "projectId", "createdAt"])
        .searchIndex("search_title", { filterFields: ["organizationId", "status"], field: "title" }),

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
    // The generated bench domains (empty in the committed, core-only state).
    .extend(domains.extension);
// lunora:add:presence:end
