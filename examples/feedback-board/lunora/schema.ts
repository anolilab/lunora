import { defineSchema, defineTable, v } from "lunorash/server";

import { ratelimit } from "./ratelimit/schema.js";

/**
 * feedback-board — a public feature-request board: post, upvote, discuss, and
 * let the model read the room.
 *
 * Everything is root-scoped, so the whole board is one ShardDO and one
 * subscription stream. The interesting part is `votes`: its
 * `by_feedback_and_voter` index is `unique`, which is what actually enforces
 * one vote per person. A read-then-insert check in the mutation would still let
 * two concurrent requests both find nothing and both insert; the unique index
 * makes the second write fail no matter how the requests interleave.
 */
export default defineSchema({
    feedback: defineTable({
        title: v.string(),
        description: v.string(),
        status: v.union(
            v.literal("open"),
            v.literal("under-review"),
            v.literal("planned"),
            v.literal("in-progress"),
            v.literal("completed"),
            v.literal("closed"),
        ),
        authorName: v.string(),
        authorEmail: v.optional(v.string()),
        upvoteCount: v.number(),
        commentCount: v.number(),
        tags: v.optional(v.array(v.string())),
    })
        .index("by_status", ["status"])
        .index("by_upvotes", ["upvoteCount"]),

    votes: defineTable({
        feedbackId: v.id("feedback"),
        voterEmail: v.string(),
    })
        // `by_feedback_and_voter` doubles as the lookup for "has this person
        // voted" and as the constraint that stops them voting twice; its prefix
        // also serves "every vote on this post", so no separate index is needed.
        .index("by_feedback_and_voter", ["feedbackId", "voterEmail"], { unique: true })
        .index("by_voter", ["voterEmail"]),

    comments: defineTable({
        feedbackId: v.id("feedback"),
        authorName: v.string(),
        authorEmail: v.optional(v.string()),
        content: v.string(),
        /** Set on replies from the team, so the UI can badge them. */
        isOfficial: v.boolean(),
    }).index("by_feedback", ["feedbackId"]),

    summaries: defineTable({
        title: v.string(),
        summary: v.string(),
        feedbackIds: v.array(v.id("feedback")),
        generatedAt: v.number(),
    }).index("by_generated", ["generatedAt"]),
}).extend(ratelimit.extension);
