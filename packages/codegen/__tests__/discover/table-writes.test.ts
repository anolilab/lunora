import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverTableWrites from "../../src/discover/table-writes";
import { markerLine, scopeName } from "../call-site-fixture";

let workdir: string;

const SOURCE = `
type Id<T extends string> = string & { readonly __table: T };
interface Db {
    delete: <T extends string>(table: T, id: Id<T>) => Promise<void>;
    deleteMany: <T extends string>(table: T, ids: ReadonlyArray<Id<T>>) => Promise<unknown>;
    patch: <T extends string>(table: T, id: Id<T>, patch: object) => Promise<void>;
    patchMany: <T extends string>(table: T, patches: ReadonlyArray<{ id: Id<T>; patch: object }>) => Promise<unknown>;
    replace: <T extends string>(table: T, id: Id<T>, document: object) => Promise<void>;
    insertMany: (table: string, documents: object[]) => Promise<unknown>;
    todos: { update: () => void; upsert: (args: object) => Promise<unknown>; findMany: () => Promise<unknown> };
}
declare const mutation: (config: { handler: (ctx: { db: Db }, args: { id: Id<"todos">; raw: string }) => Promise<void> }) => unknown;

export const write = mutation({
    handler: async (ctx, args) => {
        await ctx.db.patch("todos", args.id, {});
        await ctx.db.replace("todos", args.id, {});
        await ctx.db.delete("todos", args.id);
        await ctx.db.deleteMany("todos", [args.id]);
        await ctx.db.patchMany("todos", [{ id: args.id, patch: {} }]);
        await ctx.db.insertMany("notes", []);
        await ctx.db.todos.upsert({});
        await ctx.db.todos.findMany();
        await ctx.db.delete(args.raw as never, args.id);
    },
});

const helper = async (ctx: { db: Db }, id: Id<"todos">) => ctx.db.patch("todos", id, {}); // @orphan

export const cleanup = async (ctx: { db: Db }, table: string, id: Id<"notes">) => {
    await ctx.db.delete(table as never, id); // @dynamic
};
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
            .filter((write) => scopeName(write.scope) === "write")
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

    it("keeps a write in a helper no export calls, scoped to the helper with no callers", () => {
        expect.assertions(1);

        const project = new Project({ compilerOptions: { strict: true }, skipAddingFilesFromTsConfig: true });
        const orphans = discoverTableWrites(project, join(workdir, "lunora")).filter((write) => write.scope.kind === "helper");

        expect(orphans).toStrictEqual([
            {
                fields: [],
                file: "todos",
                line: markerLine(SOURCE, "orphan"),
                method: "patch",
                scope: { callers: [], kind: "helper", name: "helper" },
                table: "todos",
            },
        ]);
    });

    it("keeps a table name that is not a literal unresolved", () => {
        expect.assertions(1);

        const project = new Project({ compilerOptions: { strict: true }, skipAddingFilesFromTsConfig: true });
        const tablesAt = new Map<number, string[]>();

        for (const write of discoverTableWrites(project, join(workdir, "lunora")).filter((entry) => scopeName(entry.scope) === "cleanup")) {
            tablesAt.set(write.line, [...(tablesAt.get(write.line) ?? []), write.table]);
        }

        expect(tablesAt.get(markerLine(SOURCE, "dynamic"))).toStrictEqual([""]);
    });

    it("reads a table name held in a constant of literal type", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "constant.ts"),
            `type Id<T extends string> = string & { readonly __table: T };
interface Db {
    patch: (table: string, id: Id<"posts">, patch: object) => Promise<void>;
}
declare const mutation: (config: { handler: (ctx: { db: Db }, args: { id: Id<"posts"> }) => Promise<void> }) => unknown;

const POSTS = "posts";

export const rename = mutation({
    handler: async (ctx, args) => {
        await ctx.db.patch(POSTS, args.id, {});
    },
});
`,
            "utf8",
        );

        const project = new Project({ compilerOptions: { strict: true }, skipAddingFilesFromTsConfig: true });
        const tables = discoverTableWrites(project, join(workdir, "lunora"))
            .filter((write) => write.file === "constant")
            .map((write) => write.table);

        expect(tables).toStrictEqual(["posts"]);
    });

    it("reads the table of a `const db = ctx.db.<table>` alias, so its id-first patch keeps its fields", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "alias.ts"),
            `type Id<T extends string> = string & { readonly __table: T };
interface Db {
    todos: { patch: (id: Id<"todos">, patch: object) => Promise<void> };
    patch: (table: string, id: string, patch: object) => Promise<void>;
}
declare const mutation: (config: { handler: (ctx: { db: Db }, args: { id: Id<"todos"> }) => Promise<void> }) => unknown;

export const rename = mutation({
    handler: async (ctx, args) => {
        const db = ctx.db.todos;

        await db.patch(args.id, { title: "x" });
    },
});
`,
            "utf8",
        );

        const project = new Project({ compilerOptions: { strict: true }, skipAddingFilesFromTsConfig: true });
        const writes = discoverTableWrites(project, join(workdir, "lunora"))
            .filter((write) => write.file === "alias")
            .map((write) => [write.method, write.table, write.fields]);

        expect(writes).toStrictEqual([["patch", "todos", ["title"]]]);
    });

    it("does not read the table of a `let` alias, which may be reassigned before the write", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "mutable.ts"),
            `type Id<T extends string> = string & { readonly __table: T };
interface Db {
    todos: { patch: (id: Id<"todos">, patch: object) => Promise<void> };
    patch: (table: string, id: string, patch: object) => Promise<void>;
}
declare const mutation: (config: { handler: (ctx: { db: Db }, args: { id: Id<"todos"> }) => Promise<void> }) => unknown;

export const rename = mutation({
    handler: async (ctx, args) => {
        let db = ctx.db.todos;

        await db.patch(args.id, { title: "x" });
    },
});
`,
            "utf8",
        );

        const project = new Project({ compilerOptions: { strict: true }, skipAddingFilesFromTsConfig: true });
        const writes = discoverTableWrites(project, join(workdir, "lunora"))
            .filter((write) => write.file === "mutable")
            .map((write) => [write.method, write.table, write.fields]);

        expect(writes).toStrictEqual([["patch", "", undefined]]);
    });
});
