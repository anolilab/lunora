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
});
