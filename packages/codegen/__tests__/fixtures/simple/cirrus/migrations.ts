import { defineMigration } from "@cirrus/server";

export const backfillReadBy = defineMigration({
    id: "backfill-read-by",
    table: "messages",
    up: (document) => ({ ...document, readBy: [] }),
});
