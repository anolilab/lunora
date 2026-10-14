import { DatabaseSync } from "node:sqlite";

import type { SqlExec } from "@lunora/shard-engine";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { createInProcessRuntime, resolveInProcessIdentity, runRegisteredFunction } from "../src/in-process";
import { defineSchema, defineTable } from "../src/schema";

const schema = defineSchema({ notes: defineTable({ body: v.string() }) });

const nodeSqlExec = (): SqlExec => {
    const database = new DatabaseSync(":memory:");

    return {
        exec: <Row>(query: string, ...params: unknown[]) => {
            const rows = database.prepare(query).all(...(params as never[])) as Row[];

            return { one: () => rows[0] as Row, [Symbol.iterator]: () => rows[Symbol.iterator](), toArray: () => rows };
        },
    };
};

describe(createInProcessRuntime, () => {
    it("migrates the schema and rolls back every write of a body that throws", async () => {
        expect.assertions(3);

        const runtime = createInProcessRuntime(schema, { sql: nodeSqlExec() });
        const { database } = runtime.createWriters(resolveInProcessIdentity(null));

        await runtime.runInTransaction(async () => database.insert("notes", { body: "kept" }));

        await expect(
            runtime.runInTransaction(async () => {
                await database.insert("notes", { body: "dropped" });

                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");

        const rows = await runtime.runInTransaction(async () => database.query("notes").collect());

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ body: "kept" });
    });

    it("forwards only a non-empty subject, and its claims without it", () => {
        expect.assertions(3);

        expect(resolveInProcessIdentity({ roles: ["admin"] })).toStrictEqual({ claims: null, userId: null });
        expect(resolveInProcessIdentity({ userId: "ada" })).toStrictEqual({ claims: null, userId: "ada" });
        expect(resolveInProcessIdentity({ roles: ["admin"], userId: "ada" })).toStrictEqual({ claims: { roles: ["admin"] }, userId: "ada" });
    });

    it("refuses an internal function from outside and a reference of the wrong kind", () => {
        expect.assertions(2);

        const internal = { handler: () => 1, kind: "mutation", visibility: "internal" };

        expect(() => runRegisteredFunction("mutation", internal, {}, {}, false)).toThrow("internal function");
        expect(() => runRegisteredFunction("query", internal, {}, {}, true)).toThrow("expected a registered query");
    });
});
