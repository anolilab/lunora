import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverTableWrites from "../../src/discover/table-writes";

let workdir: string;

const SOURCE = `
type Id<T extends string> = string & { readonly __table: T };
interface Db {
    delete: <T extends string>(id: Id<T>) => Promise<void>;
    deleteMany: <T extends string>(ids: ReadonlyArray<Id<T>>) => Promise<unknown>;
    patch: <T extends string>(id: Id<T>, patch: object) => Promise<void>;
    patchMany: <T extends string>(patches: ReadonlyArray<{ id: Id<T>; patch: object }>) => Promise<unknown>;
    replace: <T extends string>(id: Id<T>, document: object) => Promise<void>;
    insertMany: (table: string, documents: object[]) => Promise<unknown>;
    todos: { update: () => void; upsert: (args: object) => Promise<unknown>; findMany: () => Promise<unknown> };
}
declare const mutation: (config: { handler: (ctx: { db: Db }, args: { id: Id<"todos">; raw: string }) => Promise<void> }) => unknown;

export const write = mutation({
    handler: async (ctx, args) => {
        await ctx.db.patch(args.id, {});
        await ctx.db.replace(args.id, {});
        await ctx.db.delete(args.id);
        await ctx.db.deleteMany([args.id]);
        await ctx.db.patchMany([{ id: args.id, patch: {} }]);
        await ctx.db.insertMany("notes", []);
        await ctx.db.todos.upsert({});
        await ctx.db.todos.findMany();
        await ctx.db.delete(args.raw as never);
    },
});

const helper = async (ctx: { db: Db }, id: Id<"todos">) => ctx.db.patch(id, {});

const removeEither = async (ctx: { db: Db }, id: Id<"notes"> | Id<"todos">) => ctx.db.delete(id);
// An optional id handed straight to delete: the table is still "notes".
const removeMaybe = async (ctx: { db: Db }, id: Id<"notes"> | undefined) => ctx.db.delete(id);

export const cleanup = mutation({
    handler: async (ctx, args) => {
        await removeEither(ctx, args.id);
        await removeMaybe(ctx, undefined);
    },
});
`;

describe("discoverTableWrites", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-table-writes-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "todos.ts"), SOURCE, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reads the table off an Id<> type, a literal name, or the facade receiver", () => {
        expect.assertions(1);

        const project = new Project({ compilerOptions: { strict: true }, skipAddingFilesFromTsConfig: true });
        const writes = discoverTableWrites(project, join(workdir, "lunora"))
            .filter((write) => write.exportName === "write")
            .map((write) => `${write.method}:${write.table}`);

        // Reads are not writes, and an untyped id yields "".
        expect(writes).toStrictEqual([
            "patch:todos",
            "replace:todos",
            "delete:todos",
            "deleteMany:todos",
            "patchMany:todos",
            "insertMany:notes",
            "upsert:todos",
            "delete:",
        ]);
    });

    it("keeps a write in a helper no export calls, with an empty export and the helper's name", () => {
        expect.assertions(1);

        const project = new Project({ compilerOptions: { strict: true }, skipAddingFilesFromTsConfig: true });
        const orphans = discoverTableWrites(project, join(workdir, "lunora")).filter((write) => write.exportName === "");

        expect(orphans).toStrictEqual([{ exportName: "", file: "todos", helper: "helper", line: 28, method: "patch", table: "todos" }]);
    });

    it("records one write per table of a union id, and reads through `| undefined`", () => {
        expect.assertions(1);

        const project = new Project({ compilerOptions: { strict: true }, skipAddingFilesFromTsConfig: true });
        const writes = discoverTableWrites(project, join(workdir, "lunora"))
            .filter((write) => write.exportName === "cleanup")
            .map((write) => `${String(write.line)}:${write.method}:${write.table}`);

        expect(writes.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["30:delete:notes", "30:delete:todos", "32:delete:notes"]);
    });
});
