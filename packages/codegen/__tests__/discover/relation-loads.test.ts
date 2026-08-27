import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverRelationLoads from "../src/discover-relation-loads";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

const rowFor = (exportName: string) => discoverRelationLoads(project, join(workdir, "lunora")).find((row) => row.exportName === exportName);

describe("discoverRelationLoads", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-relation-loads-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a with-hydrated relation on a public facade read", () => {
        expect.assertions(2);

        write("list.ts", `export const listPosts = query(async ({ ctx }) => ctx.db.posts.findMany({ with: { author: true } }));`);

        expect(rowFor("listPosts")).toBeDefined();
        expect(rowFor("listPosts")).toMatchObject({ parentTable: "posts", relations: ["author"], visibility: "public" });
    });

    it("records every relation accessor a with map declares", () => {
        expect.assertions(1);

        write("multi.ts", `export const listMulti = query(async ({ ctx }) => ctx.db.posts.findMany({ with: { author: true, comments: true } }));`);

        expect(rowFor("listMulti")?.relations).toStrictEqual(["author", "comments"]);
    });

    it("records a shorthand relation accessor name", () => {
        expect.assertions(1);

        write("shorthand.ts", `export const listShorthand = query(async ({ author, ctx }) => ctx.db.posts.findMany({ with: { author } }));`);

        expect(rowFor("listShorthand")?.relations).toStrictEqual(["author"]);
    });

    it("reads the parent table from the table-arg read form", () => {
        expect.assertions(1);

        write("tablearg.ts", `export const listArg = query(async ({ ctx }) => ctx.db.findMany("posts", { with: { author: true } }));`);

        expect(rowFor("listArg")).toMatchObject({ parentTable: "posts", relations: ["author"] });
    });

    it("classifies an internalQuery reader as internal visibility", () => {
        expect.assertions(1);

        write("admin.ts", `export const adminList = internalQuery(async ({ ctx }) => ctx.db.posts.findMany({ with: { author: true } }));`);

        expect(rowFor("adminList")).toMatchObject({ parentTable: "posts", visibility: "internal" });
    });

    it("skips a read with no with map", () => {
        expect.assertions(1);

        write("plain.ts", `export const listPlain = query(async ({ ctx }) => ctx.db.posts.findMany({ order: "asc" }));`);

        expect(discoverRelationLoads(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does not classify a non-procedure export", () => {
        expect.assertions(1);

        write("helper.ts", `export const helper = wrap(async ({ ctx }) => ctx.db.posts.findMany({ with: { author: true } }));`);

        expect(discoverRelationLoads(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
