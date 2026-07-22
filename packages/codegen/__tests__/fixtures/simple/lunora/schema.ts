import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"])
        .searchIndex("by_text", { field: "text", filterFields: ["channelId"] }),

    users: defineTable({
        email: v.string(),
        name: v.string(),
        role: v.literal("admin"),
        prefs: v.record(v.string(), v.string()),
    })
        .global()
        .index("by_email", ["email"], { unique: true })
        .relations((r) => ({
            attachments: r.many("attachments", { field: "ownerId" }),
        })),

    // Coverage table — exercises `v.geoPoint()` + `.geoIndex()` (the geospatial
    // query surface) so the emitted `GeoIndexNamesByTable` / geo-point column type
    // are asserted by the golden fixture.
    places: defineTable({
        location: v.geoPoint(),
        name: v.string(),
    }).geoIndex("by_location", { field: "location" }),

    // Coverage table — exercises `.ttl()` so the emitted `LUNORA_TTL_SWEEPS`
    // manifest + the shard's `ttlSweeps()` override are asserted by the fixture.
    sessions: defineTable({
        expiresAt: v.timestamp(),
        token: v.string(),
    }).ttl("expiresAt"),

    // Coverage table — exercises the drizzle emitter's optional/array/bigint/bytes/
    // storage branches. Not used by any function; the codegen tests just assert that
    // the emitted columns match the expected drizzle shapes.
    attachments: defineTable({
        bytes: v.bytes(),
        fileKey: v.storage(),
        ownerId: v.id("users"),
        size: v.bigint(),
        tags: v.array(v.string()),
        title: v.optional(v.string()),
    })
        .global()
        .relations((r) => ({
            owner: r.one("users", { field: "ownerId", onDelete: "cascade" }),
        })),
});
