/**
 * App catalog installs: which of an organization's projects run a catalog app, at
 * which version and deployment. An install claims its project's row (`installing`)
 * before it writes anything, and becomes `live` once its release is up. A row left
 * `installing` by a crashed install stops blocking the project after its lease.
 *
 * Composed into the schema by `lunora/schema.ts`.
 */
import { defineTable, v } from "@lunora/server";

export const catalogTables = {
    catalogInstalls: defineTable({
        createdAt: v.number(),
        // Set once the release is live.
        deploymentId: v.optional(v.string()),
        installedBy: v.string(),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        slug: v.string(),
        status: v.union(v.literal("installing"), v.literal("live")),
        version: v.string(),
    })
        .global()
        .index("by_org", ["organizationId"])
        .index("by_project", ["projectId"]),
};
