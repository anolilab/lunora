import { defineSchema, defineTable, v } from "@lunora/server";

// A default export, like every template and example — the generated `shard.ts`
// imports it as `import schema from "../schema.js"`, so a named-only export
// leaves the emitted code unresolvable (which is invisible until something
// compiles it, as nothing did).
export default defineSchema({
    // Shard-local (`.shardBy`): rows live in one DO, so a shape over this table is
    // served from that DO's own op-log via the CDC poke path.
    notes: defineTable({
        boardId: v.string(),
        body: v.string(),
        ownerId: v.string(),
    })
        .shardBy("boardId")
        .ownedBy("ownerId")
        .index("by_board", ["boardId"]),

    // `.global()`: D1-backed, no per-DO op-log — a shape over this table is served
    // by the latency-tiered poll path instead (`readGlobalShapeRows` for the
    // membership, `readGlobalChangedTables` for the "did anything move?" tick).
    // Both overrides are emitted only when a project has shapes AND global tables,
    // which is the pairing this fixture exists to pin down.
    boards: defineTable({
        name: v.string(),
        ownerId: v.string(),
    })
        .global()
        .ownedBy("ownerId")
        .index("by_owner", ["ownerId"]),

    // `.source(...)`: rows are ingested by the shard's poll loop from an external
    // database reached through a wrangler Hyperdrive binding. Here so the ingest
    // seam is COMPILED — `ShardDOConfig.sourceClient` and the `defineApp()` builder
    // method that fills it. Without a sourced fixture the whole feature was inert:
    // the config field and the poll loop shipped, nothing on the builder could
    // reach them, and every tick recorded "no sourceClient resolved for binding".
    //
    // `refresh: "manual"` deliberately: an auto-refresh source arms a poll alarm in
    // the emitted constructor, and this fixture's `shard.ts` is also instantiated
    // by the dispatch tests, which must not start ingesting. Every emission this
    // fixture exists to pin is gated on the table being sourced, not on its cadence.
    contacts: defineTable({
        boardId: v.string(),
        email: v.string(),
    })
        .shardBy("boardId")
        .source({
            binding: "CONTACTS_DB",
            query: "select id, email from contacts where board_id = $1",
            refresh: "manual",
            tenantBy: (shardKey: string) => [shardKey],
        }),
});
