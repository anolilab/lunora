import { describe, expect, it, vi } from "vitest";

import type { FacadeWriterLike } from "../src/facade";
import { bindTableFacade } from "../src/facade";

/**
 * `bindTableFacade` pins a `tableName` on the structural writer so the per-table
 * accessor (`ctx.db.&lt;table>.*`) forwards it as `expectedTable` on by-id calls —
 * the IDOR guard. These tests assert the batch forms (added alongside `insertMany`)
 * forward the bound table, and that `patchMany` maps the facade's `values` payload
 * onto the writer's `{ id, patch }` shape.
 */
const makeWriter = () => {
    const deleteMany = vi.fn();
    const patchMany = vi.fn();
    const insertMany = vi.fn();
    const deleteOne = vi.fn();
    const patchOne = vi.fn();

    const writer = {
        aggregate: vi.fn(),
        count: vi.fn(),
        delete: deleteOne,
        deleteMany,
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn(),
        findMany: vi.fn(),
        get: vi.fn(),
        groupBy: vi.fn(),
        insert: vi.fn(),
        insertMany,
        patch: patchOne,
        patchMany,
        query: vi.fn(),
        rank: vi.fn(),
        rankPage: vi.fn(),
        replace: vi.fn(),
    } as unknown as FacadeWriterLike;

    return { deleteMany, deleteOne, entry: bindTableFacade(writer, "messages"), insertMany, patchMany, patchOne };
};

describe("bindTableFacade — per-table batch forms", () => {
    it("deleteMany forwards the bound table as expectedTable", async () => {
        expect.assertions(1);

        const { deleteMany, entry } = makeWriter();

        await entry.deleteMany(["a", "b"], { limit: 5 });

        expect(deleteMany).toHaveBeenCalledWith(["a", "b"], { limit: 5 }, "messages");
    });

    it("patchMany maps `values` to `{ id, patch }` and forwards the bound table", async () => {
        expect.assertions(1);

        const { entry, patchMany } = makeWriter();

        await entry.patchMany([{ id: "a", values: { body: "x" } }], { limit: 5 });

        expect(patchMany).toHaveBeenCalledWith([{ id: "a", patch: { body: "x" } }], { limit: 5 }, "messages");
    });

    it("insertMany forwards the table as the first argument (table-scoped by construction)", async () => {
        expect.assertions(1);

        const { entry, insertMany } = makeWriter();

        await entry.insertMany([{ body: "x" }], { limit: 5 });

        expect(insertMany).toHaveBeenCalledWith("messages", [{ body: "x" }], { limit: 5 });
    });

    it("single delete/patch still forward the bound table (IDOR guard unchanged)", async () => {
        expect.assertions(2);

        const { deleteOne, entry, patchOne } = makeWriter();

        await entry.delete("a");
        await entry.patch("a", { body: "x" });

        expect(deleteOne).toHaveBeenCalledWith("a", "messages");
        expect(patchOne).toHaveBeenCalledWith("a", { body: "x" }, "messages");
    });
});
