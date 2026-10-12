/**
 * The package's own tables, installed with `defineSchema(...).extend(privacyExtension)`.
 * They are prefixed `privacy_` by the extension key. The schema holds the request
 * state, its event log, the retention holds, the archive of records kept past
 * erasure, and the tombstones a restore needs to re-apply erasures.
 */
import type { SchemaExtension, TableDefinition } from "@lunora/server";
import { defineSchemaExtension, defineTable, v } from "@lunora/server";

/** The five table names, before the `privacy_` prefix. */
export type PrivacyTableName = "archive" | "events" | "holds" | "requests" | "tombstones";

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
        }).index("bySubjectDataset", ["subjectId", "datasetId"]),

        events: defineTable({
            at: v.number(),
            detail: v.optional(v.string()),
            kind: v.string(),
            requestId: v.string(),
        }).index("byRequest", ["requestId", "at"]),

        holds: defineTable({
            datasetId: v.string(),
            requestId: v.optional(v.string()),
            retainUntil: v.number(),
            rule: v.string(),
            subjectId: v.string(),
        }).index("bySubject", ["subjectId"]),

        requests: defineTable({
            dueAt: v.number(),
            errorMessage: v.optional(v.string()),
            erasureGraceUntil: v.optional(v.number()),
            expiresAt: v.optional(v.number()),
            extendedDueAt: v.optional(v.number()),
            progress: v.number(),
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
            verifiedAt: v.optional(v.number()),
            workflowInstanceId: v.optional(v.string()),
        })
            .index("byRequestId", ["requestId"])
            .index("bySubject", ["subjectId", "type"])
            .index("byStatus", ["status", "dueAt"]),

        tombstones: defineTable({
            erasedAt: v.number(),
            scope: v.string(),
            subjectKey: v.string(),
        }).index("bySubjectKey", ["subjectKey"]),
    },
});
