import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/do";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase, readD1CdcChanges, trimD1CdcChanges } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Change-data-capture changelog for global (D1) tables, against a real
 * `node:sqlite` engine. CDC is opt-in via `createD1CtxDb({ cdc: true })`; the
 * `__cdc_log` table is created lazily by `ensureMigrated` alongside the other
 * companion tables, and every committed write appends a post-image.
 */
const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

const todosSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            shape: { text: col("string") },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

const setupWriter = (cdc: boolean): DatabaseWriterLike => {
    harness.ddl(
        `CREATE TABLE "todos" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "text" TEXT
        )`,
    );

    return createD1ContextDatabase({ cdc, clock: () => FIXED_CLOCK, exec: harness.exec, schema: todosSchema });
};

const tableExists = async (name: string): Promise<boolean> => {
    const rows = await harness.exec.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);

    return rows.length > 0;
};

describe("d1 ctx-db change-data-capture", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("does not create the changelog table when CDC is disabled", async () => {
        expect.assertions(1);

        const writer = setupWriter(false);

        await writer.insert("todos", { _id: "t_1", text: "hi" }, { allowExplicitId: true });

        await expect(tableExists("__cdc_log")).resolves.toBe(false);
    });

    it("records insert / update / delete in monotonic seq order with post-images", async () => {
        expect.assertions(5);

        const writer = setupWriter(true);

        await writer.insert("todos", { _id: "t_1", text: "hi" }, { allowExplicitId: true });
        await writer.patch("t_1", { text: "edited" });
        await writer.delete("t_1");

        const { changes, cursor } = await readD1CdcChanges(harness.exec);

        expect(changes.map((change) => change.op)).toStrictEqual(["insert", "update", "delete"]);
        expect(changes.map((change) => change.seq)).toStrictEqual([1, 2, 3]);
        expect(cursor).toBe(3);
        expect(changes[1]?.doc).toMatchObject({ text: "edited" });
        // delete carries no document — the id identifies the removed row.
        expect(changes[2]?.doc).toBeUndefined();
    });

    it("pages from a cursor and trims at a checkpoint", async () => {
        expect.assertions(3);

        const writer = setupWriter(true);

        await writer.insert("todos", { _id: "a", text: "1" }, { allowExplicitId: true });
        await writer.insert("todos", { _id: "b", text: "2" }, { allowExplicitId: true });
        await writer.insert("todos", { _id: "c", text: "3" }, { allowExplicitId: true });

        const firstPage = await readD1CdcChanges(harness.exec, { limit: 2 });

        expect(firstPage.changes.map((change) => change.id)).toStrictEqual(["a", "b"]);

        const secondPage = await readD1CdcChanges(harness.exec, { sinceSeq: firstPage.cursor });

        expect(secondPage.changes.map((change) => change.id)).toStrictEqual(["c"]);

        await trimD1CdcChanges(harness.exec, 2);

        const remaining = await readD1CdcChanges(harness.exec);

        expect(remaining.changes.map((change) => change.id)).toStrictEqual(["c"]);
    });
});
