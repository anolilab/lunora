import { defineShape, v } from "@lunora/server";

/**
 * Op-log-backed shape over a `.shardBy()` table — the shard-local half of delta
 * sync. `owner: true` resolves through the table's `.ownedBy("ownerId")`, so the
 * emitted `resolveShape` has to look the owning column up off the schema.
 */
export const boardNotes = defineShape({
    args: { boardId: v.string() },
    owner: true,
    table: "notes",
    where: (_context, { boardId }) => {
        return { boardId };
    },
});

/**
 * Shape over a `.global()` table — the half that only works when the global
 * writer is built with CDC on: `readGlobalChangedTables` reads the global
 * `__cdc_log`, and without it the poll tick can never learn the table moved.
 */
export const myBoards = defineShape({ owner: true, table: "boards" });
