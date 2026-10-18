import { v } from "@lunora/values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A `.default(value)` literal that is an object or array is declared once, in the
 * schema, and applied to every insert that omits the column. If each insert
 * handed out that same reference, anything that mutated the row it was given (an
 * `onWrite` hook, a trigger's `doc`) would rewrite the default for every insert
 * after it.
 */
const schema = {
    tables: {
        notes: { indexes: [], shape: { tags: v.array(v.string()).default([]), title: v.string() } },
    },
} as unknown as SchemaLike;

let harness: ReturnType<typeof createSqliteExec>;
let writer: DatabaseWriterLike;
let seen: Record<string, unknown> | undefined;

describe("insert applies an object default without sharing it", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        seen = undefined;
        writer = createShardContextDatabase({
            clock: () => 1_700_000_000_000,
            onWrite: ({ doc }) => {
                seen = doc;
            },
            schema,
            sql: harness.sql,
        });
    });

    afterEach(() => {
        harness.close();
    });

    it("a hook that mutates one inserted row does not change the default of the next", async () => {
        expect.assertions(2);

        await writer.insert("notes", { title: "first" });
        (seen?.["tags"] as string[]).push("leaked");

        const id = await writer.insert("notes", { title: "second" });
        const row = await writer.get(id);

        expect(row?.["tags"]).toStrictEqual([]);
        expect(seen?.["tags"]).toStrictEqual([]);
    });
});
