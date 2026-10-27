import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * workos-auth — Lunora with WorkOS AuthKit as the identity provider.
 *
 * One per-user table. `ownerId` is the WorkOS user id (`user_…`), stamped from
 * the verified session token; `orgId` is the WorkOS organization that was
 * active when the note was written, if any.
 */
export default defineSchema({
    notes: defineTable({
        ownerId: v.string(),
        orgId: v.optional(v.string()),
        text: v.string(),
        createdAt: v.number(),
    })
        .index("by_owner", ["ownerId", "createdAt"])
        .index("by_org", ["orgId", "createdAt"]),
});
