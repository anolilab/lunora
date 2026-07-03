import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverRawRowReturns from "../src/discover-raw-row-returns";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

const discover = () => discoverRawRowReturns(project, join(workdir, "lunora"));
const rowFor = (exportName: string) => discover().find((row) => row.exportName === exportName);

describe("discoverRawRowReturns", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-raw-row-returns-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a public query returning a facade findMany read directly (concise body)", () => {
        expect.assertions(2);

        write("list.ts", `export const listUsers = query(async ({ ctx }) => ctx.db.users.findMany());`);

        expect(rowFor("listUsers")).toBeDefined();
        expect(rowFor("listUsers")).toMatchObject({ table: "users", usesMask: false, usesOutput: false, visibility: "public" });
    });

    it("records a findFirst returned from a block body", () => {
        expect.assertions(1);

        write(
            "one.ts",
            `export const getUser = query(async ({ args, ctx }) => {
                return ctx.db.users.findFirst({ where: { _id: args.id } });
            });`,
        );

        expect(rowFor("getUser")).toMatchObject({ table: "users", visibility: "public" });
    });

    it("records a fluent ctx.db.query(...).collect() chain", () => {
        expect.assertions(1);

        write("fluent.ts", `export const listFluent = query(async ({ ctx }) => ctx.db.query("users").withIndex("by_name").collect());`);

        expect(rowFor("listFluent")).toMatchObject({ table: "users" });
    });

    it("follows a single local const hop from the read to the return", () => {
        expect.assertions(1);

        write(
            "hop.ts",
            `export const listHopped = query(async ({ ctx }) => {
                const rows = await ctx.db.users.findMany();
                return rows;
            });`,
        );

        expect(rowFor("listHopped")).toMatchObject({ table: "users" });
    });

    it("records the object-form query({ handler }) surface", () => {
        expect.assertions(1);

        write("obj.ts", `export const listObject = query({ handler: async ({ ctx }) => ctx.db.users.findMany() });`);

        expect(rowFor("listObject")).toMatchObject({ table: "users", visibility: "public" });
    });

    it("marks a builder chain with .output(...) as usesOutput", () => {
        expect.assertions(1);

        write(
            "projected.ts",
            `export const listProjected = query
                .input({ limit: v.number() })
                .output(v.array(v.object({ id: v.string() })))
                .query(async ({ ctx }) => ctx.db.users.findMany());`,
        );

        expect(rowFor("listProjected")).toMatchObject({ table: "users", usesOutput: true });
    });

    it("marks a builder chain with .use(mask(...)) as usesMask", () => {
        expect.assertions(1);

        write(
            "masked.ts",
            `export const listMasked = query
                .use(mask({ users: { email: "redact" } }))
                .query(async ({ ctx }) => ctx.db.users.findMany());`,
        );

        expect(rowFor("listMasked")).toMatchObject({ table: "users", usesMask: true });
    });

    it("classifies an internalQuery reader as internal visibility", () => {
        expect.assertions(1);

        write("admin.ts", `export const listAdmin = internalQuery(async ({ ctx }) => ctx.db.users.findMany());`);

        expect(rowFor("listAdmin")).toMatchObject({ table: "users", visibility: "internal" });
    });

    it("does not record a hand-built .map(...) projection", () => {
        expect.assertions(1);

        write(
            "mapped.ts",
            `export const listMapped = query(async ({ ctx }) => {
                const rows = await ctx.db.users.findMany();
                return rows.map((row) => ({ id: row._id, name: row.name }));
            });`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("does not record a return wrapped in a hand-built object literal", () => {
        expect.assertions(1);

        write(
            "wrapped.ts",
            `export const getWrapped = query(async ({ args, ctx }) => {
                const user = await ctx.db.users.findFirst({ where: { _id: args.id } });
                return { user, ok: true };
            });`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("does not record a mutation returning a read (only queries hand rows to the caller)", () => {
        expect.assertions(1);

        write("mut.ts", `export const touch = mutation(async ({ ctx }) => ctx.db.users.findMany());`);

        expect(discover()).toHaveLength(0);
    });

    it("records an empty table for a by-id get whose table isn't a string literal", () => {
        expect.assertions(1);

        write("byid.ts", `export const getById = query(async ({ args, ctx }) => ctx.db.get(args.id));`);

        expect(rowFor("getById")).toMatchObject({ table: "" });
    });

    it("does not classify a non-procedure export", () => {
        expect.assertions(1);

        write("helper.ts", `export const helper = wrap(async ({ ctx }) => ctx.db.users.findMany());`);

        expect(discover()).toHaveLength(0);
    });
});
