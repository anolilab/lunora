import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * clerk-auth — Lunora with Clerk as the identity provider.
 *
 * One per-user table. `ownerId` is the Clerk user id (`user_…`), stamped from
 * the verified session token; `orgId` is the Clerk organization that was
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
