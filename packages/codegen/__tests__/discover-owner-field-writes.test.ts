import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverOwnerFieldWrites from "../src/discover-owner-field-writes";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverOwnerFieldWrites", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-owner-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags an insert whose doc sets userId from args", () => {
        expect.assertions(2);

        write("create.ts", `export const create = mutation(async ({ ctx, args }) => { await ctx.db.insert("posts", { userId: args.userId }); });`);

        const found = discoverOwnerFieldWrites(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "create", field: "userId", file: "create", line: 1, method: "insert" });
    });

    it("flags a patch whose partial sets ownerId from args", () => {
        expect.assertions(2);

        write("rename.ts", `export const rename = mutation(async ({ ctx, args }) => { await ctx.db.patch(args.id, { ownerId: args.ownerId }); });`);

        const found = discoverOwnerFieldWrites(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "ownerId", method: "patch" });
    });

    it("flags a shorthand identity property bound to an args value through one local hop", () => {
        expect.assertions(2);

        write("hop.ts", `export const create = mutation(async ({ ctx, args }) => { const userId = args.userId; await ctx.db.insert("posts", { userId }); });`);

        const found = discoverOwnerFieldWrites(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "userId", method: "insert" });
    });

    it("flags one offending element of an insertManyUnsafe array", () => {
        expect.assertions(2);

        write(
            "import.ts",
            `export const importRows = mutation(async ({ ctx, args }) => { await ctx.db.insertManyUnsafe("posts", [{ userId: args.userId }, { title: args.title }]); });`,
        );

        const found = discoverOwnerFieldWrites(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "userId", method: "insertManyUnsafe" });
    });

    it("ignores an ownership column stamped from ctx", () => {
        expect.assertions(1);

        write("safe.ts", `export const create = mutation(async ({ ctx, args }) => { await ctx.db.insert("posts", { userId: ctx.auth.userId }); });`);

        expect(discoverOwnerFieldWrites(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a non-identity column written from args", () => {
        expect.assertions(1);

        write("title.ts", `export const create = mutation(async ({ ctx, args }) => { await ctx.db.insert("posts", { title: args.title }); });`);

        expect(discoverOwnerFieldWrites(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores an ownership column set to a fixed literal", () => {
        expect.assertions(1);

        write("literal.ts", `export const create = mutation(async ({ ctx, args }) => { await ctx.db.insert("posts", { userId: "system" }); });`);

        expect(discoverOwnerFieldWrites(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
