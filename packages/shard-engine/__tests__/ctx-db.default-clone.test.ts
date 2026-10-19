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
        // Values the wire codec round-trips but `structuredClone` cannot copy (a `URL`) or copies lossily.
        links: {
            indexes: [],
            shape: {
                at: v.any().default(new Date(1_700_000_000_000)),
                nested: v.any().default({ home: new URL("https://example.com/home") }),
                target: v.any().default(new URL("https://example.com/a?b=1")),
                title: v.string(),
            },
        },
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

    it("keeps a URL default a URL, on its own and inside a plain object", async () => {
        expect.assertions(4);

        const id = await writer.insert("links", { title: "x" });
        const row = await writer.get(id);

        expect(row?.["target"]).toBeInstanceOf(URL);
        expect((row?.["target"] as URL).href).toBe("https://example.com/a?b=1");
        expect((row?.["nested"] as { home: unknown }).home).toBeInstanceOf(URL);
        expect((row?.["nested"] as { home: URL }).home.href).toBe("https://example.com/home");
    });

    it("keeps a Date default a Date", async () => {
        expect.assertions(2);

        const id = await writer.insert("links", { title: "x" });
        const row = await writer.get(id);

        expect(row?.["at"]).toBeInstanceOf(Date);
        expect((row?.["at"] as Date).getTime()).toBe(1_700_000_000_000);
    });
});
