import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Soft delete on the D1 (global) column dialect: the parity twin of
 * `@lunora/do`'s `ctx-db.soft-delete` suite. `delete()` stamps the marker column
 * (an UPDATE, mirroring `patch`'s all-column write) instead of removing the row;
 * list reads/count hide soft-deleted rows; `{ hard: true }` physically removes;
 * and a soft delete cascades as a soft delete.
 */
const FIXED_CLOCK = 1_700_000_000_000;

const schema: SchemaLike = {
    tables: {
        projects: {
            indexes: [],
            relationMap: {},
            shape: { deletedAt: { kind: "number" }, name: { kind: "string" } },
            softDeleteMode: { field: "deletedAt" },
        },
        todos: {
            indexes: [],
            relationMap: { project: { field: "projectId", kind: "one", onDelete: "cascade", references: "_id", table: "projects" } },
            shape: { deletedAt: { kind: "number" }, projectId: { kind: "string" }, title: { kind: "string" } },
            softDeleteMode: { field: "deletedAt" },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

const setup = (): DatabaseWriterLike => {
    harness.ddl(`CREATE TABLE "projects" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "name" TEXT, "deletedAt" INTEGER)`);
    harness.ddl(
        `CREATE TABLE "todos" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "projectId" TEXT, "title" TEXT, "deletedAt" INTEGER)`,
    );

    return createD1ContextDatabase({ clock: () => FIXED_CLOCK, exec: harness.exec, schema });
};

const ids = (result: { page: Record<string, unknown>[] }): unknown[] =>
    result.page.map((document_) => document_["_id"]).toSorted((a, b) => String(a).localeCompare(String(b)));

const seedTodos = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", projectId: "p1", title: "one" }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t2", projectId: "p1", title: "two" }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t3", projectId: "p1", title: "three" }, { allowExplicitId: true });
};

describe("d1 ctx-db soft delete", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("delete() hides the row from list reads but keeps it reachable by id", async () => {
        expect.assertions(4);

        const writer = setup();

        await seedTodos(writer);
        await writer.delete("t2", "todos");

        expect(ids(await writer.findMany("todos", {}))).toStrictEqual(["t1", "t3"]);
        await expect(writer.count("todos")).resolves.toBe(2);

        const row = await writer.get("t2", "todos");

        expect(row?.["deletedAt"]).toBe(FIXED_CLOCK);
        expect(row?.["title"]).toBe("two");
    });

    it("includeDeleted re-includes soft-deleted rows", async () => {
        expect.assertions(1);

        const writer = setup();

        await seedTodos(writer);
        await writer.delete("t2", "todos");

        expect(ids(await writer.findMany("todos", { includeDeleted: true }))).toStrictEqual(["t1", "t2", "t3"]);
    });

    it("restore (patch the marker to null) brings the row back", async () => {
        expect.assertions(1);

        const writer = setup();

        await seedTodos(writer);
        await writer.delete("t2", "todos");

        await writer.patch("t2", { deletedAt: null }, "todos");

        await expect(writer.count("todos")).resolves.toBe(3);
    });

    it("delete({ hard: true }) physically removes the row", async () => {
        expect.assertions(2);

        const writer = setup();

        await seedTodos(writer);
        await writer.delete("t3", "todos", { hard: true });

        await expect(writer.get("t3", "todos")).resolves.toBeNull();
        expect(ids(await writer.findMany("todos", { includeDeleted: true }))).toStrictEqual(["t1", "t2"]);
    });

    it("a soft delete cascades as a soft delete to onDelete:cascade children", async () => {
        expect.assertions(3);

        const writer = setup();

        await writer.insert("projects", { _id: "p1", name: "Project" }, { allowExplicitId: true });
        await seedTodos(writer);

        await writer.delete("p1", "projects");

        await expect(writer.count("projects")).resolves.toBe(0);
        await expect(writer.count("todos")).resolves.toBe(0);
        expect(ids(await writer.findMany("todos", { includeDeleted: true }))).toStrictEqual(["t1", "t2", "t3"]);
    });
});
