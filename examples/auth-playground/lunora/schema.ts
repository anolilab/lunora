import { defineSchema, defineTable, v } from "lunorash/server";

import { ratelimit } from "./ratelimit/schema.js";

/**
 * auth-playground — demo schema for the better-auth org/admin plugins.
 *
 * `documents` is the only project-owned table; identity tables (user,
 * session, account, verification) plus org/admin tables (organization,
 * member, invitation, …) are managed by better-auth and live in D1 — they
 * are NOT declared here. `compileMigrationsSql(auth.options)` emits the DDL
 * for those at deploy time.
 *
 * Each `documents` row carries the `ownerId` of the user who created it, and
 * that is the only isolation this table has. It is stamped from the resolved
 * session, never taken from client args, so it is a boundary the server can
 * enforce. There is deliberately no `organizationId` column — see the long note
 * in `documents.ts` for why a tenant id a procedure context cannot verify is
 * worse than no tenant id at all.
 *
 * The index leads with `ownerId` (the equality prefix) and ends with
 * `createdAt` (the sort key), so `list` reads its page in order straight off
 * the index instead of sorting matches in JS.
 */
export default defineSchema({
    documents: defineTable({
        ownerId: v.string(),
        title: v.string(),
        body: v.string(),
        createdAt: v.number(),
    }).index("by_owner_created", ["ownerId", "createdAt"]),
}).extend(ratelimit.extension);
