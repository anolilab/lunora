import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../src/ctx-db";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

const text = { _meta: { column: { notNull: true } }, kind: "string" } as ValidatorLike;

/** A before-delete trigger on `posts` that records the deletion in `audit`, through the writer it is handed. */
const schema = {
    tables: {
        audit: { indexes: [], shape: { postId: text }, shardMode: { kind: "global" } },
        posts: {
            indexes: [],
            shape: { title: text },
            shardMode: { kind: "global" },
            triggerMap: {
                recordDeletion: {
                    handler: async (
                        context: { db: { insert: (table: string, document: Record<string, unknown>) => Promise<string> } },
                        event: { id: string },
                    ) => {
                        await context.db.insert("audit", { postId: event.id });
                    },
                    op: "delete",
                    timing: "before",
                },
            },
        },
    },
} as never as SchemaLike;

let harness: ReturnType<typeof createSqliteHarness>;

describe("createSqlCtxDb onWrite", () => {
    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("announces the table a trigger wrote through the writer, not only the table the caller wrote", async () => {
        expect.assertions(1);

        const written: string[] = [];
        const writer = createSqlCtxDb({
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec: harness.exec,
            onWrite: (table) => {
                written.push(table);
            },
            schema,
        });
        const id = await writer.insert("posts", { title: "hello" });

        written.length = 0;
        await writer.delete("posts", id);

        expect(written).toStrictEqual(["audit", "posts"]);
    });

    it("announces nothing for a write that stored no row", async () => {
        expect.assertions(1);

        const written: string[] = [];
        const writer = createSqlCtxDb({
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec: harness.exec,
            onWrite: (table) => {
                written.push(table);
            },
            schema,
        });

        await writer.delete("posts", "missing");

        expect(written).toStrictEqual([]);
    });
});
