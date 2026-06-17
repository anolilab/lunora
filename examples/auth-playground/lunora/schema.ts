import { defineSchema, defineTable, v } from "lunora/server";

/**
 * auth-playground — demo schema for the better-auth org/admin plugins.
 *
 * `documents` is the only project-owned table; identity tables (user,
 * session, account, verification) plus org/admin tables (organization,
 * member, invitation, …) are managed by better-auth and live in D1 — they
 * are NOT declared here. `compileMigrationsSql(auth.options)` emits the DDL
 * for those at deploy time.
 *
 * Each `documents` row carries an `organizationId` so handlers can gate
 * reads/writes by organization membership.
 */
export default defineSchema({
    documents: defineTable({
        organizationId: v.string(),
        ownerId: v.string(),
        title: v.string(),
        body: v.string(),
        createdAt: v.number(),
    }).index("by_org_created", ["organizationId", "createdAt"]),
});
