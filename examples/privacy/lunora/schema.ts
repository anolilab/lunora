import { privacyExtension } from "@lunora/privacy";
import { defineSchema, defineTable, v } from "lunorash/server";

import { ratelimit } from "./ratelimit/schema.js";

/**
 * privacy-example: a task list where every row belongs to one user, plus the
 * package's request tables. The `userId` column is what the coverage check reads:
 * `tasks` must be covered by a dataset in `lunora/privacy.ts`, or the build fails.
 *
 * `exportFiles` holds the archive parts the package writes between steps. This
 * example keeps them in the shard, because it has no object-storage binding.
 */
export default defineSchema({
    tasks: defineTable({
        createdAt: v.number(),
        done: v.boolean(),
        title: v.string(),
        userId: v.string(),
    }).index("byUser", ["userId"]),
    /** Invoices carry a `de.voucher` retention rule, so erasure keeps them and their `issuedAt` starts the period. */
    invoices: defineTable({
        amount: v.number(),
        issuedAt: v.number(),
        number: v.string(),
        userId: v.string(),
    }).index("byUser", ["userId"]),
    exportFiles: defineTable({
        body: v.string(),
        encoding: v.union(v.literal("text"), v.literal("base64")),
        name: v.string(),
        requestId: v.string(),
    }).index("byRequestAndName", ["requestId", "name"]),
})
    .extend(ratelimit.extension)
    .extend(privacyExtension);
