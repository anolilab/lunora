/**
 * Lifecycle notifications: the channels an org routes deploy, domain and preview
 * events to, and the outbox of deliveries the edge sweep sends.
 *
 * Composed into the schema by `lunora/schema.ts`.
 */
import { defineTable, v } from "@lunora/server";

export const notificationTables = {
    // Lifecycle notification channels — where an org's deploy / domain / preview
    // events are announced. Admin-managed. `destination` is the webhook URL for
    // slack/discord/webhook, or the chat id for telegram. `secret` is the telegram
    // bot token or the webhook HMAC signing key; it never leaves the server except
    // once, at creation for webhook channels. Reads mask both (lunora/notifications.ts).
    notificationChannels: defineTable({
        createdAt: v.number(),
        destination: v.string(),
        enabled: v.boolean(),
        events: v.array(
            v.union(
                v.literal("deployment.live"),
                v.literal("deployment.failed"),
                v.literal("deployment.rolled_back"),
                v.literal("domain.verified"),
                v.literal("domain.failed"),
                v.literal("preview.expired"),
            ),
        ),
        kind: v.union(v.literal("discord"), v.literal("slack"), v.literal("telegram"), v.literal("webhook")),
        name: v.string(),
        organizationId: v.id("organizations"),
        // The bot token (telegram) or HMAC signing key (webhook), AES-256-GCM sealed at
        // the edge with SECRET_ENCRYPTION_KEY (see POST /v1/notification-channels).
        secretCiphertext: v.optional(v.string()),
        secretIv: v.optional(v.string()),
        updatedAt: v.number(),
    })
        .global()
        .index("by_org", ["organizationId"]),

    // Notification outbox — one row per (event, enabled subscribed channel). The
    // mutation that causes an event inserts `pending` rows; the every-minute edge
    // sweep (src/notifications/sweep.ts) delivers them and stamps `delivered` or
    // `failed`. Rows denormalize the rendered message so the sweep needs no re-read.
    notificationDeliveries: defineTable({
        // Send attempts so far. A retryable failure reschedules the row at `nextAttemptAt`
        // (exponential backoff) until the attempt budget is spent, then it is `failed`.
        attempts: v.number(),
        body: v.string(),
        channelId: v.id("notificationChannels"),
        createdAt: v.number(),
        deliveredAt: v.optional(v.number()),
        error: v.optional(v.string()),
        event: v.union(
            v.literal("deployment.live"),
            v.literal("deployment.failed"),
            v.literal("deployment.rolled_back"),
            v.literal("domain.verified"),
            v.literal("domain.failed"),
            v.literal("preview.expired"),
            v.literal("test"),
        ),
        kind: v.union(v.literal("discord"), v.literal("slack"), v.literal("telegram"), v.literal("webhook")),
        // Earliest time the sweep may (re)send a `pending` row.
        nextAttemptAt: v.number(),
        organizationId: v.id("organizations"),
        status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed")),
        subject: v.string(),
        updatedAt: v.number(),
    })
        .global()
        .index("by_org", ["organizationId"])
        .index("by_status", ["status"]),

};
