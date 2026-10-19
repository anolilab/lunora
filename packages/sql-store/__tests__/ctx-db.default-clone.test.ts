import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../src/ctx-db";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

let seen: Record<string, unknown> | undefined;

/**
 * A `.default(value)` literal that is an object or array is declared once, in the
 * schema, and applied to every insert that omits the column. If each insert
 * handed out that same reference, anything that mutated the row it was given (a
 * trigger's `doc`) would rewrite the default for every insert after it.
 */
const schema = {
    tables: {
        notes: {
            indexes: [],
            shape: {
                tags: { _meta: { column: { defaultValue: [], notNull: true } }, kind: "array" } as ValidatorLike,
                title: { _meta: { column: { notNull: true } }, kind: "string" } as ValidatorLike,
            },
            shardMode: { kind: "global" },
            triggerMap: {
                capture: {
                    handler: (_context: unknown, event: { doc?: Record<string, unknown> }) => {
                        seen = event.doc;
                    },
                    op: "insert",
                    timing: "after",
                },
            },
        },
    },
} as never as SchemaLike;

let harness: ReturnType<typeof createSqliteHarness>;
let writer: ReturnType<typeof createSqlCtxDb>;

describe("createSqlCtxDb insert applies an object default without sharing it", () => {
    beforeEach(() => {
        harness = createSqliteHarness();
        seen = undefined;
        writer = createSqlCtxDb({
            clock: () => 1_700_000_000_000,
            dialect: makeSqliteDialect(),
            exec: harness.exec,
            schema,
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
