import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Soft delete (`.softDelete()` → `softDeleteMode`). `delete()` flips the marker
 * column instead of removing the row; LIST reads hide soft-deleted rows unless
 * `includeDeleted` is passed; by-id `get` still returns them; a physical removal
 * needs `{ hard: true }`; and a soft delete cascades as a soft delete. Run
 * against real SQLite.
 */
const schema: SchemaLike = {
    tables: {
        projects: {
            indexes: [],
            relationMap: {},
            shape: { deletedAt: { kind: "number" }, name: { kind: "string" } },
            softDeleteMode: { field: "deletedAt" },
        },
        todos: {
            indexes: [{ fields: ["projectId"], name: "by_project" }],
            // A cascade FK to projects: deleting a project deletes its todos.
            relationMap: { project: { field: "projectId", kind: "one", onDelete: "cascade", references: "_id", table: "projects" } },
            shape: { deletedAt: { kind: "number" }, projectId: { kind: "string" }, title: { kind: "string" } },
            softDeleteMode: { field: "deletedAt" },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const setup = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

const ids = (result: Record<string, unknown>[] | { page: Record<string, unknown>[] }): unknown[] =>
    (Array.isArray(result) ? result : result.page).map((document_) => document_["_id"]);

const seedTodos = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", projectId: "p1", title: "one" }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t2", projectId: "p1", title: "two" }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t3", projectId: "p1", title: "three" }, { allowExplicitId: true });
};

describe("ctx-db soft delete", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("delete() flips the marker and hides the row from list reads", async () => {
        expect.assertions(5);

        const writer = setup();

        await seedTodos(writer);
        await writer.delete("t2", "todos");

        // The row is gone from findMany, the fluent reader, and count…
        expect(ids(await writer.findMany("todos", {}))).toStrictEqual(["t1", "t3"]);
        expect(ids(await writer.query("todos").collect())).toStrictEqual(["t1", "t3"]);
        await expect(writer.count("todos")).resolves.toBe(2);

        // …but it's still physically there, marker stamped, reachable by id.
        const row = await writer.get("t2", "todos");

        expect(row?.["deletedAt"]).toBe(1_700_000_000_000);
        expect(row?.["title"]).toBe("two");
    });

    it("includeDeleted re-includes soft-deleted rows in findMany", async () => {
        expect.assertions(1);

        const writer = setup();

        await seedTodos(writer);
        await writer.delete("t2", "todos");

        expect(ids(await writer.findMany("todos", { includeDeleted: true }))).toStrictEqual(["t1", "t2", "t3"]);
    });

    it("restore (patch the marker to null) brings the row back", async () => {
        expect.assertions(2);

        const writer = setup();

        await seedTodos(writer);
        await writer.delete("t2", "todos");

        await writer.patch("t2", { deletedAt: null }, "todos");

        expect(ids(await writer.findMany("todos", {}))).toStrictEqual(["t1", "t2", "t3"]);
        await expect(writer.count("todos")).resolves.toBe(3);
    });

    it("delete({ hard: true }) physically removes the row", async () => {
        expect.assertions(2);

        const writer = setup();

        await seedTodos(writer);
        await writer.delete("t3", "todos", { hard: true });

        await expect(writer.get("t3", "todos")).resolves.toBeNull();
        // Even includeDeleted can't see a hard-deleted row.
        expect(ids(await writer.findMany("todos", { includeDeleted: true }))).toStrictEqual(["t1", "t2"]);
    });

    it("a soft delete cascades as a soft delete to onDelete:cascade children", async () => {
        expect.assertions(3);

        const writer = setup();

        await writer.insert("projects", { _id: "p1", name: "Project" }, { allowExplicitId: true });
        await seedTodos(writer);

        await writer.delete("p1", "projects");

        // The project and all its todos are hidden from list reads…
        await expect(writer.count("projects")).resolves.toBe(0);
        await expect(writer.count("todos")).resolves.toBe(0);
        // …but the children are soft-deleted (still present), not physically gone.
        expect(ids(await writer.findMany("todos", { includeDeleted: true }))).toStrictEqual(["t1", "t2", "t3"]);
    });

    it("composes the soft-delete scope with an injected baseWhere (RLS) — neither bypasses the other", async () => {
        expect.assertions(3);

        const writer = setup();

        await seedTodos(writer);
        await writer.delete("t2", "todos");

        // `baseWhere` is how RLS injects a read policy. Both filters AND together:
        // only LIVE rows in project p1.
        expect(ids(await writer.findMany("todos", { baseWhere: { projectId: "p1" } }))).toStrictEqual(["t1", "t3"]);

        // `includeDeleted` relaxes the soft-delete scope but NOT the policy baseWhere.
        expect(ids(await writer.findMany("todos", { baseWhere: { projectId: "p1" }, includeDeleted: true }))).toStrictEqual(["t1", "t2", "t3"]);

        // A baseWhere the row fails wins even with includeDeleted — soft-delete
        // can't be used to read around the policy.
        expect(ids(await writer.findMany("todos", { baseWhere: { projectId: "other" }, includeDeleted: true }))).toStrictEqual([]);
    });

    it("a second delete of an already-soft-deleted row is a no-op", async () => {
        expect.assertions(1);

        const writer = setup();

        await seedTodos(writer);
        await writer.delete("t2", "todos");
        await writer.delete("t2", "todos");

        // Still exactly one soft-deleted row, marker unchanged.
        expect(ids(await writer.findMany("todos", { includeDeleted: true }))).toStrictEqual(["t1", "t2", "t3"]);
    });
});
