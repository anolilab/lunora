import { defineShape, v } from "@lunora/server";

/** Op-log-backed shape over the `.shardBy()` table. */
export const boardNotes = defineShape({
    args: { boardId: v.string() },
    owner: true,
    table: "notes",
    where: (_context, { boardId }) => {
        return { boardId };
    },
});

/**
 * Shape over the Hyperdrive-backed `.global(...)` table — the pairing that emits
 * `readGlobalShapeRows` / `readGlobalChangedTables` against `config.hyperdriveGlobal`.
 */
export const myBoards = defineShape({ owner: true, table: "boards" });
