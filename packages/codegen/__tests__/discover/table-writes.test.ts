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

const helper = async (ctx: { db: Db }, id: Id<"todos">) => ctx.db.patch(id, {}); // @orphan

export const cleanup = async (
    ctx: { db: Db },
    either: Id<"notes"> | Id<"todos">,
    maybe: Id<"notes"> | undefined,
    nullable: Id<"notes"> | null,
    inner: Id<"notes" | "todos">,
    loose: Id<"notes"> | string,
    wide: Id<string>,
) => {
    await ctx.db.delete(either); // @either
    await ctx.db.delete(maybe); // @maybe
    await ctx.db.delete(nullable); // @nullable
    await ctx.db.delete(inner); // @inner
    await ctx.db.delete(loose); // @loose
    await ctx.db.delete(wide); // @wide
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
            { file: "todos", line: markerLine(SOURCE, "orphan"), method: "patch", scope: { callers: [], kind: "helper", name: "helper" }, table: "todos" },
        ]);
    });

    it("records one write per table of a union id, drops nullish members, and keeps an unreadable union unresolved", () => {
        expect.assertions(1);

        const project = new Project({ compilerOptions: { strict: true }, skipAddingFilesFromTsConfig: true });
        const tablesAt = new Map<number, string[]>();

        for (const write of discoverTableWrites(project, join(workdir, "lunora")).filter((entry) => scopeName(entry.scope) === "cleanup")) {
            tablesAt.set(
                write.line,
                [...(tablesAt.get(write.line) ?? []), write.table].toSorted((a, b) => a.localeCompare(b)),
            );
        }

        expect(
            Object.fromEntries(["either", "maybe", "nullable", "inner", "loose", "wide"].map((marker) => [marker, tablesAt.get(markerLine(SOURCE, marker))])),
        ).toStrictEqual({
            either: ["notes", "todos"],
            inner: ["notes", "todos"],
            // `Id<"notes"> | string`: the plain `string` member has no table to read.
            loose: [""],
            maybe: ["notes"],
            nullable: ["notes"],
            // `Id<string>`: no literal table.
            wide: [""],
        });
    });
});
