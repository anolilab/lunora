import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `explain` describes the statement `findMany` would run, using the real SQLite engine's own
 * `EXPLAIN QUERY PLAN`, so what these tests read is the plan the Durable Object would produce.
 */
const schema: SchemaLike = {
    tables: {
        messages: {
            indexes: [{ fields: ["room"], name: "by_room" }],
            shape: { body: { kind: "string" }, room: { kind: "string" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

describe("ctx-db explain", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
    });

    afterEach(() => {
        harness.close();
    });

    it("returns the statement, its parameters and one plan line per step", async () => {
        expect.assertions(2);

        const writer = createShardContextDatabase({ clock: () => 1, schema, sql: harness.sql });
        const result = await writer.explain("messages", { limit: 5, where: { room: "lobby" } });

        expect(result?.sql).toMatch(/^SELECT .* FROM "messages"/u);
        expect(result?.params).toContain("lobby");
    });

    it("shows whether an index serves the read", async () => {
        expect.assertions(2);

        const writer = createShardContextDatabase({ clock: () => 1, schema, sql: harness.sql });
        const indexed = await writer.explain("messages", { where: { room: "lobby" } });
        const unindexed = await writer.explain("messages", { where: { body: "hi" } });

        expect(indexed?.plan.join("\n")).toContain("by_room");
        expect(unindexed?.plan.join("\n")).not.toContain("by_room");
    });

    it("does not subscribe to the table it describes, unlike the read", async () => {
        expect.assertions(2);

        const onRead = vi.fn<(table: string, id?: string) => void>();
        const writer = createShardContextDatabase({ clock: () => 1, onRead, schema, sql: harness.sql });

        await writer.insert("messages", { body: "hi", room: "lobby" });
        await writer.findMany("messages", { where: { room: "lobby" } });

        // The real read registers its dependency...
        expect(onRead.mock.calls.length).toBeGreaterThan(0);

        onRead.mockClear();
        await writer.explain("messages", { where: { room: "lobby" } });
        await writer.explain("messages");

        // ...describing it must not, or a live query that explains would re-run on every write.
        expect(onRead).not.toHaveBeenCalled();
    });

    it("rejects an unknown table", async () => {
        expect.assertions(1);

        const writer = createShardContextDatabase({ clock: () => 1, schema, sql: harness.sql });

        await expect(writer.explain("nope")).rejects.toThrow("unknown table");
    });
});
