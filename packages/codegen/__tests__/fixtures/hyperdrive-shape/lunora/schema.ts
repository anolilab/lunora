import { defineSchema, defineTable, v } from "@lunora/server";

/**
 * The Hyperdrive twin of the `delta-sync` fixture: `defineShape`s over a
 * **Hyperdrive-backed** `.global(...)` table.
 *
 * `delta-sync` is D1-only, and the two backends emit different code in the very
 * places the shape overrides live — so the Hyperdrive half of
 * `readGlobalShapeRows` / `readGlobalChangedTables` had no compiled output
 * anywhere, and shipped emitting a `shard.ts` that did not typecheck.
 */
export default defineSchema({
    notes: defineTable({
        boardId: v.string(),
        body: v.string(),
        ownerId: v.string(),
    })
        .shardBy("boardId")
        .ownedBy("ownerId")
        .index("by_board", ["boardId"]),

    boards: defineTable({
        name: v.string(),
        ownerId: v.string(),
    })
        .global({ backend: "hyperdrive" })
        .ownedBy("ownerId")
        .index("by_owner", ["ownerId"]),
});
