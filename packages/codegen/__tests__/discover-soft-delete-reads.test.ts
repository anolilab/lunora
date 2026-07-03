import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverSoftDeleteReads from "../src/discover-soft-delete-reads";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

const rowFor = (exportName: string) => discoverSoftDeleteReads(project, join(workdir, "lunora")).find((row) => row.exportName === exportName);

describe("discoverSoftDeleteReads", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-soft-delete-reads-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a hardcoded includeDeleted: true on a public facade read", () => {
        expect.assertions(2);

        write("trash.ts", `export const listTrash = query(async ({ ctx }) => ctx.db.posts.findMany({ includeDeleted: true }));`);

        expect(rowFor("listTrash")).toBeDefined();
        expect(rowFor("listTrash")).toMatchObject({ fromArgs: false, hardcodedTrue: true, table: "posts", visibility: "public" });
    });

    it("records an includeDeleted wired directly from args", () => {
        expect.assertions(1);

        write("list.ts", `export const listPosts = query(async ({ args, ctx }) => ctx.db.posts.findMany({ includeDeleted: args.showDeleted }));`);

        expect(rowFor("listPosts")).toMatchObject({ fromArgs: true, hardcodedTrue: false, table: "posts", visibility: "public" });
    });

    it("follows a single local hop from args to includeDeleted", () => {
        expect.assertions(1);

        write(
            "hop.ts",
            `export const listHopped = query(async ({ args, ctx }) => {
                const showDeleted = args.showDeleted;
                return ctx.db.posts.findMany({ includeDeleted: showDeleted });
            });`,
        );

        expect(rowFor("listHopped")).toMatchObject({ fromArgs: true, hardcodedTrue: false, table: "posts" });
    });

    it("reads the table from the table-arg read form", () => {
        expect.assertions(1);

        write("tablearg.ts", `export const listArg = query(async ({ ctx }) => ctx.db.findMany("posts", { includeDeleted: true }));`);

        expect(rowFor("listArg")).toMatchObject({ hardcodedTrue: true, table: "posts", visibility: "public" });
    });

    it("classifies an internalQuery reader as internal visibility", () => {
        expect.assertions(1);

        write("admin.ts", `export const adminTrash = internalQuery(async ({ ctx }) => ctx.db.posts.findMany({ includeDeleted: true }));`);

        expect(rowFor("adminTrash")).toMatchObject({ hardcodedTrue: true, table: "posts", visibility: "internal" });
    });

    it("skips a literal includeDeleted: false", () => {
        expect.assertions(1);

        write("hidden.ts", `export const listLive = query(async ({ ctx }) => ctx.db.posts.findMany({ includeDeleted: false }));`);

        expect(discoverSoftDeleteReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("skips an includeDeleted gated by a server-trusted ctx value", () => {
        expect.assertions(1);

        write("gated.ts", `export const listGated = query(async ({ ctx }) => ctx.db.posts.findMany({ includeDeleted: ctx.isAdmin }));`);

        expect(discoverSoftDeleteReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("skips a read that passes no includeDeleted option", () => {
        expect.assertions(1);

        write("plain.ts", `export const listPlain = query(async ({ ctx }) => ctx.db.posts.findMany({ order: "asc" }));`);

        expect(discoverSoftDeleteReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does not classify a non-procedure export", () => {
        expect.assertions(1);

        write("helper.ts", `export const helper = wrap(async ({ ctx }) => ctx.db.posts.findMany({ includeDeleted: true }));`);

        expect(discoverSoftDeleteReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
