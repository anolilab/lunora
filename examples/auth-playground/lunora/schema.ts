import { defineSchema, defineTable, v } from "lunorash/server";

/**
 * auth-playground — demo schema for the better-auth org/admin plugins.
 *
 * `documents` is the only project-owned table; identity tables (user,
 * session, account, verification) plus org/admin tables (organization,
 * member, invitation, …) are managed by better-auth and live in D1 — they
 * are NOT declared here. `compileMigrationsSql(auth.options)` emits the DDL
 * for those at deploy time.
 *
 * Each `documents` row carries the `organizationId` it was filed under and the
 * `ownerId` of the user who created it. `ownerId` is what `documents.ts`
 * enforces isolation on — it is stamped from the resolved session, never taken
 * from client args, so it is the only field here the server actually trusts.
 *
 * The index leads with `organizationId` + `ownerId` (the equality prefix) and
 * ends with `createdAt` (the sort key), so `list` reads its page in order
 * straight off the index instead of sorting matches in JS.
 */
export default defineSchema({
    documents: defineTable({
        organizationId: v.string(),
        ownerId: v.string(),
        title: v.string(),
        body: v.string(),
        createdAt: v.number(),
    }).index("by_org_owner_created", ["organizationId", "ownerId", "createdAt"]),
});
