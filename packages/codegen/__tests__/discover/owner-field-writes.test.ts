import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverMutators } from "../../src/discover/mutators";
import discoverOwnerFieldWrites from "../../src/discover/owner-field-writes";

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

    // `defineMutator({ owner: "userId" })` makes `args.userId` the server-verified
    // identity before the `server` impl runs: `applyOwnerScope` rejects a call with
    // no identity, rejects a client-supplied value that disagrees, and overwrites
    // the column with the verified one. Writing it back out is the documented
    // shape, and flagging it at ERROR is a false positive on Lunora's own docs.
    it("does not flag a mutator writing the very column its `owner` declares", () => {
        expect.assertions(1);

        write(
            "mutators.ts",
            `export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { await ctx.db.insert("posts", { userId: args.userId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");

        expect(discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory))).toHaveLength(0);
    });

    it("still flags a DIFFERENT identity column in an owner-scoped mutator", () => {
        // `owner: "userId"` launders `userId` and nothing else — a `tenantId` taken
        // from `args` in the same impl is still caller-controlled.
        expect.assertions(2);

        write(
            "mutators.ts",
            `export const createPost = defineMutator({ owner: "userId", server: async (ctx, args) => { await ctx.db.insert("posts", { tenantId: args.tenantId, userId: args.userId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");
        const found = discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ field: "tenantId" });
    });

    it("still flags an owner-column write in a mutator that declares no `owner`", () => {
        expect.assertions(1);

        write(
            "mutators.ts",
            `export const createPost = defineMutator({ server: async (ctx, args) => { await ctx.db.insert("posts", { userId: args.userId }); } });`,
        );

        const lunoraDirectory = join(workdir, "lunora");

        expect(discoverOwnerFieldWrites(project, lunoraDirectory, [], discoverMutators(project, lunoraDirectory))).toHaveLength(1);
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
