/**
 * `explain` on a `.global()` table, against a **real** D1 binding in workerd.
 *
 * `explain` prefixes the statement a read compiles to with `EXPLAIN QUERY PLAN`. D1 is SQLite behind
 * an authorizer that refuses some statements (it refuses pragma table-valued functions through the
 * binding), so whether it admits this one, and what shape its rows have, has to be asked of D1.
 * Each test owns a table name: D1 storage is shared across the tests in this file.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../../src/ctx-db";
import { col, d1Dialect, d1Exec } from "./_helpers/d1";

const schemaFor = (table: string): SchemaLike =>
    ({
        tables: {
            [table]: { indexes: [{ fields: ["room"], name: "by_room" }], shape: { body: col("string"), room: col("string") }, shardMode: { kind: "global" } },
        },
    }) as never;

describe("explain on D1", () => {
    it("reports the plan D1 chose, naming the index that serves the read", async () => {
        expect.assertions(3);

        const table = "explain_messages";
        const writer = createSqlCtxDb({ clock: () => 1, dialect: d1Dialect, exec: d1Exec, schema: schemaFor(table) });

        await writer.insert(table, { body: "hi", room: "lobby" });

        const indexed = await writer.explain(table, { where: { room: "lobby" } });
        const scanned = await writer.explain(table, { where: { body: "hi" } });

        expect(indexed?.plan.join("\n")).toContain("by_room");
        expect(scanned?.plan.length).toBeGreaterThan(0);
        expect(scanned?.plan.join("\n")).not.toContain("by_room");
    });
});
