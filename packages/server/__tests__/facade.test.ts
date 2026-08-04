import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import type { FacadeWriterLike } from "../src/facade";
import { bindTableFacade } from "../src/facade";

/**
 * `bindTableFacade` pins a `tableName` on the structural writer so the per-table
 * accessor (`ctx.db.<table>.*`) forwards it as `expectedTable` on by-id calls —
 * the IDOR guard. These tests assert the batch forms (added alongside `insertMany`)
 * forward the bound table, and that `patchMany` maps the facade's `values` payload
 * onto the writer's `{ id, patch }` shape.
 */
const makeWriter = () => {
    const deleteMany = vi.fn<NonNullable<FacadeWriterLike["deleteMany"]>>();
    const deleteWhere = vi.fn<NonNullable<FacadeWriterLike["deleteWhere"]>>();
    const patchMany = vi.fn<NonNullable<FacadeWriterLike["patchMany"]>>();
    const patchWhere = vi.fn<NonNullable<FacadeWriterLike["patchWhere"]>>();
    const insertMany = vi.fn<NonNullable<FacadeWriterLike["insertMany"]>>();
    const deleteOne = vi.fn<FacadeWriterLike["delete"]>();
    const patchOne = vi.fn<FacadeWriterLike["patch"]>();

    const writer = {
        aggregate: vi.fn<FacadeWriterLike["aggregate"]>(),
        count: vi.fn<FacadeWriterLike["count"]>(),
        delete: deleteOne,
        deleteMany,
        deleteWhere,
        findFirst: vi.fn<FacadeWriterLike["findFirst"]>(),
        findFirstOrThrow: vi.fn<FacadeWriterLike["findFirstOrThrow"]>(),
        findMany: vi.fn<FacadeWriterLike["findMany"]>(),
        get: vi.fn<FacadeWriterLike["get"]>(),
        groupBy: vi.fn<FacadeWriterLike["groupBy"]>(),
        insert: vi.fn<FacadeWriterLike["insert"]>(),
        insertMany,
        patch: patchOne,
        patchMany,
        patchWhere,
        query: vi.fn<FacadeWriterLike["query"]>(),
        rank: vi.fn<FacadeWriterLike["rank"]>(),
        rankPage: vi.fn<FacadeWriterLike["rankPage"]>(),
        replace: vi.fn<FacadeWriterLike["replace"]>(),
    } as unknown as FacadeWriterLike;

    return { deleteMany, deleteOne, deleteWhere, entry: bindTableFacade(writer, "messages"), insertMany, patchMany, patchOne, patchWhere };
};

describe("bindTableFacade — per-table batch forms", () => {
    it("deleteMany(ids) forwards the bound table as expectedTable", async () => {
        expect.assertions(1);

        const { deleteMany, entry } = makeWriter();

        await entry.deleteMany(["a", "b"], { limit: 5 });

        expect(deleteMany).toHaveBeenCalledWith(["a", "b"], { limit: 5 }, "messages");
    });

    it("deleteMany({ where }) routes to the writer's deleteWhere with the bound table", async () => {
        expect.assertions(1);

        const { deleteWhere, entry } = makeWriter();

        await entry.deleteMany({ where: { authorId: "a1" } });

        expect(deleteWhere).toHaveBeenCalledWith("messages", { authorId: "a1" }, { limit: undefined });
    });

    it("patchMany([...]) maps `values` to `{ id, patch }` and forwards the bound table", async () => {
        expect.assertions(1);

        const { entry, patchMany } = makeWriter();

        await entry.patchMany([{ id: "a", values: { body: "x" } }], { limit: 5 });

        expect(patchMany).toHaveBeenCalledWith([{ id: "a", patch: { body: "x" } }], { limit: 5 }, "messages");
    });

    it("patchMany({ where, values }) routes to the writer's patchWhere with the bound table", async () => {
        expect.assertions(1);

        const { entry, patchWhere } = makeWriter();

        await entry.patchMany({ where: { authorId: "a1" }, values: { body: "x" } });

        expect(patchWhere).toHaveBeenCalledWith("messages", { where: { authorId: "a1" }, patch: { body: "x" } }, { limit: undefined });
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

/** A ConflictError-shaped value (matched structurally by the facade, no `@lunora/do` import). */
const uniqueConflict = (): LunoraError & { kind: string } => {
    const err = new LunoraError("CONFLICT", `unique constraint violation on "users"`) as LunoraError & { kind: string };
    err.kind = "unique";

    return err;
};

/** A writer with individually-controllable findFirst/insert/patch, bound to the `users` table. */
const makeComposingWriter = () => {
    const findFirst = vi.fn<FacadeWriterLike["findFirst"]>();
    const insert = vi.fn<FacadeWriterLike["insert"]>();
    const patch = vi.fn<FacadeWriterLike["patch"]>();

    const writer = {
        aggregate: vi.fn<FacadeWriterLike["aggregate"]>(),
        count: vi.fn<FacadeWriterLike["count"]>(),
        delete: vi.fn<FacadeWriterLike["delete"]>(),
        deleteMany: vi.fn<NonNullable<FacadeWriterLike["deleteMany"]>>(),
        findFirst,
        findFirstOrThrow: vi.fn<FacadeWriterLike["findFirstOrThrow"]>(),
        findMany: vi.fn<FacadeWriterLike["findMany"]>(),
        get: vi.fn<FacadeWriterLike["get"]>(),
        groupBy: vi.fn<FacadeWriterLike["groupBy"]>(),
        insert,
        insertMany: vi.fn<NonNullable<FacadeWriterLike["insertMany"]>>(),
        patch,
        patchMany: vi.fn<NonNullable<FacadeWriterLike["patchMany"]>>(),
        query: vi.fn<FacadeWriterLike["query"]>(),
        rank: vi.fn<FacadeWriterLike["rank"]>(),
        rankPage: vi.fn<FacadeWriterLike["rankPage"]>(),
        replace: vi.fn<FacadeWriterLike["replace"]>(),
    } as unknown as FacadeWriterLike;

    return { entry: bindTableFacade(writer, "users"), findFirst, insert, patch };
};

describe("bindTableFacade — exists", () => {
    it("returns true when findFirst matches and forwards the where", async () => {
        expect.assertions(2);

        const { entry, findFirst } = makeComposingWriter();

        findFirst.mockResolvedValue({ _id: "u1", email: "a@b.c" });

        await expect(entry.exists({ email: "a@b.c" })).resolves.toBe(true);
        expect(findFirst).toHaveBeenCalledWith("users", { where: { email: "a@b.c" } });
    });

    it("returns false when findFirst finds nothing, and probes for any row when no where is given", async () => {
        expect.assertions(2);

        const { entry, findFirst } = makeComposingWriter();

        findFirst.mockResolvedValue(null);

        await expect(entry.exists()).resolves.toBe(false);
        expect(findFirst).toHaveBeenCalledWith("users", undefined);
    });
});

describe("bindTableFacade — insert skipDuplicates", () => {
    it("returns the id on a successful insert", async () => {
        expect.assertions(1);

        const { entry, insert } = makeComposingWriter();

        insert.mockResolvedValue("u1");

        await expect(entry.insert({ email: "a@b.c" }, { skipDuplicates: true })).resolves.toBe("u1");
    });

    it("resolves to null when the insert hits a unique conflict", async () => {
        expect.assertions(1);

        const { entry, insert } = makeComposingWriter();

        insert.mockRejectedValue(uniqueConflict());

        await expect(entry.insert({ email: "a@b.c" }, { skipDuplicates: true })).resolves.toBeNull();
    });

    it("rethrows a non-unique error even with skipDuplicates", async () => {
        expect.assertions(1);

        const { entry, insert } = makeComposingWriter();

        insert.mockRejectedValue(new Error("disk full"));

        await expect(entry.insert({ email: "a@b.c" }, { skipDuplicates: true })).rejects.toThrow("disk full");
    });

    it("propagates a unique conflict when skipDuplicates is not set", async () => {
        expect.assertions(1);

        const { entry, insert } = makeComposingWriter();

        insert.mockRejectedValue(uniqueConflict());

        await expect(entry.insert({ email: "a@b.c" })).rejects.toThrow("unique constraint");
    });
});

describe("bindTableFacade — upsert / upsertMany", () => {
    it("patches the matched row (update defaults to create) and reports created:false", async () => {
        expect.assertions(4);

        const { entry, findFirst, insert, patch } = makeComposingWriter();

        findFirst.mockResolvedValue({ _id: "u1", email: "a@b.c", name: "old" });

        await expect(entry.upsert({ create: { email: "a@b.c", name: "new" }, target: "email" })).resolves.toStrictEqual({ created: false, id: "u1" });
        // The lookup uses the target value from `create`; the patch scopes to the bound table.
        expect(findFirst).toHaveBeenCalledWith("users", { where: { email: "a@b.c" } });
        expect(patch).toHaveBeenCalledWith("u1", { email: "a@b.c", name: "new" }, "users");
        expect(insert).not.toHaveBeenCalled();
    });

    it("applies an explicit update payload when the row exists", async () => {
        expect.assertions(1);

        const { entry, findFirst, patch } = makeComposingWriter();

        findFirst.mockResolvedValue({ _id: "u1", email: "a@b.c" });

        await entry.upsert({ create: { email: "a@b.c", name: "n" }, target: "email", update: { name: "patched" } });

        expect(patch).toHaveBeenCalledWith("u1", { name: "patched" }, "users");
    });

    it("inserts and reports created:true when no row matches", async () => {
        expect.assertions(3);

        const { entry, findFirst, insert, patch } = makeComposingWriter();

        findFirst.mockResolvedValue(null);
        insert.mockResolvedValue("u2");

        await expect(entry.upsert({ create: { email: "x@y.z", name: "n" }, target: "email" })).resolves.toStrictEqual({ created: true, id: "u2" });
        expect(insert).toHaveBeenCalledWith("users", { email: "x@y.z", name: "n" });
        expect(patch).not.toHaveBeenCalled();
    });

    it("builds a composite where for a multi-field target", async () => {
        expect.assertions(1);

        const { entry, findFirst } = makeComposingWriter();

        findFirst.mockResolvedValue(null);

        await entry.upsert({ create: { name: "n", orgId: "o1", slug: "s1" }, target: ["orgId", "slug"] });

        expect(findFirst).toHaveBeenCalledWith("users", { where: { orgId: "o1", slug: "s1" } });
    });

    it("throws when a target field is missing from the create document", async () => {
        expect.assertions(1);

        const { entry } = makeComposingWriter();

        await expect(entry.upsert({ create: { name: "n" }, target: "email" })).rejects.toThrow('target field "email" is missing');
    });

    it("upsertMany applies one upsert per row, in order", async () => {
        expect.assertions(2);

        const { entry, findFirst, insert } = makeComposingWriter();

        // First row is new (insert), second already exists (patch).
        findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: "u9", email: "b@b.c" });
        insert.mockResolvedValue("u8");

        const results = await entry.upsertMany({
            rows: [{ create: { email: "a@b.c" } }, { create: { email: "b@b.c" }, update: { name: "z" } }],
            target: "email",
        });

        expect(results).toStrictEqual([
            { created: true, id: "u8" },
            { created: false, id: "u9" },
        ]);
        expect(insert).toHaveBeenCalledTimes(1);
    });

    it("propagates a write denial from the underlying writer (RLS gating on the insert path)", async () => {
        expect.assertions(1);

        const { entry, findFirst, insert } = makeComposingWriter();

        // No existing row → insert path. When this facade is bound over the
        // RLS-wrapped writer, an insert policy denial surfaces here as a throw;
        // upsert must propagate it rather than swallow it.
        findFirst.mockResolvedValue(null);
        insert.mockRejectedValue(new Error('insert on "users" denied by policy'));

        await expect(entry.upsert({ create: { email: "a@b.c" }, target: "email" })).rejects.toThrow(/denied by policy/u);
    });

    it("propagates a write denial on the update path (patch gated)", async () => {
        expect.assertions(1);

        const { entry, findFirst, patch } = makeComposingWriter();

        // Existing row → patch path; an update-policy denial must propagate.
        findFirst.mockResolvedValue({ _id: "u1", email: "a@b.c" });
        patch.mockRejectedValue(new Error('update on "users" denied by policy'));

        await expect(entry.upsert({ create: { email: "a@b.c", name: "x" }, target: "email" })).rejects.toThrow(/denied by policy/u);
    });
});
