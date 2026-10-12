/**
 * The package's own tables, installed with `defineSchema(...).extend(privacyExtension)`.
 * They are prefixed `privacy_` by the extension key. The schema holds the request
 * state, its event log, and the archive of records kept past erasure. Tombstones are
 * not here: they must survive a restore of this database, so the app keeps them elsewhere.
 */
import type { SchemaExtension, TableDefinition } from "@lunora/server";
import { defineSchemaExtension, defineTable, v } from "@lunora/server";

/** The three table names, before the `privacy_` prefix. */
export type PrivacyTableName = "archive" | "events" | "requests";

export const privacyExtension: SchemaExtension<Record<PrivacyTableName, TableDefinition>, "privacy"> = defineSchemaExtension("privacy", {
    tables: {
        archive: defineTable({
            archivedAt: v.number(),
            datasetId: v.string(),
            retainUntil: v.number(),
            /** The row as JSON, kept under a retention rule whose period has not ended. */
            row: v.string(),
            subjectId: v.string(),
            table: v.string(),
        })
            .index("bySubjectDataset", ["subjectId", "datasetId"])
            .index("byRetainUntil", ["retainUntil"]),

        events: defineTable({
            at: v.number(),
            detail: v.optional(v.string()),
            kind: v.string(),
            requestId: v.string(),
        }).index("byRequest", ["requestId", "at"]),

        requests: defineTable({
            dueAt: v.number(),
            erasureGraceUntil: v.optional(v.number()),
            expiresAt: v.optional(v.number()),
            extendedDueAt: v.optional(v.number()),
            reason: v.optional(v.string()),
            receivedAt: v.number(),
            /** The id the package hands out. Stored as a column so the app's table row id stays the app's own. */
            requestId: v.string(),
            status: v.union(
                v.literal("received"),
                v.literal("grace"),
                v.literal("processing"),
                v.literal("ready"),
                v.literal("completed"),
                v.literal("failed"),
                v.literal("cancelled"),
                v.literal("expired"),
            ),
            storageKey: v.optional(v.string()),
            subjectId: v.string(),
            type: v.union(v.literal("export"), v.literal("erasure")),
        })
            .index("byRequestId", ["requestId"])
            .index("bySubject", ["subjectId", "type"])
            .index("byStatus", ["status", "dueAt"]),
    },
});
