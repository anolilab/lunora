import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverMutatorWrites from "../src/discover-mutator-writes";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeMutators = (source: string): void => {
    writeFileSync(join(workdir, "mutators.ts"), source);
};

describe("discover-mutator-writes", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-mutator-writes-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns [] when lunora/mutators.ts does not exist", () => {
        expect.assertions(1);

        expect(discoverMutatorWrites(newProject(), workdir)).toEqual([]);
    });

    it("lifts a `ctx.db.replace(...)` from a mutator's server impl", () => {
        expect.assertions(1);

        writeMutators(`import { defineMutator } from "@lunora/server";

export const renameChannel = defineMutator({
    client: () => {},
    server: async (ctx, args) => {
        await ctx.db.replace(args.id, { name: args.name });
    },
});
`);

        expect(discoverMutatorWrites(newProject(), workdir)).toEqual([{ exportName: "renameChannel", file: "lunora/mutators.ts", line: 6 }]);
    });

    it("does not flag `ctx.db.patch(...)` — the blessed column-level write", () => {
        expect.assertions(1);

        writeMutators(`import { defineMutator } from "@lunora/server";

export const renameChannel = defineMutator({
    server: async (ctx, args) => {
        await ctx.db.patch(args.id, { name: args.name });
    },
});
`);

        expect(discoverMutatorWrites(newProject(), workdir)).toEqual([]);
    });

    it("does not flag a non-db `.replace(...)` (e.g. String.prototype.replace)", () => {
        expect.assertions(1);

        writeMutators(`import { defineMutator } from "@lunora/server";

export const renameChannel = defineMutator({
    server: async (ctx, args) => {
        const slug = args.name.replace(" ", "-");
        await ctx.db.patch(args.id, { slug });
    },
});
`);

        expect(discoverMutatorWrites(newProject(), workdir)).toEqual([]);
    });

    it("scopes the scan to the server impl, ignoring a replace in the client twin", () => {
        expect.assertions(1);

        writeMutators(`import { defineMutator } from "@lunora/server";

export const renameChannel = defineMutator({
    client: (tx, args) => {
        tx.db.replace(args.id, { name: args.name });
    },
    server: async (ctx, args) => {
        await ctx.db.patch(args.id, { name: args.name });
    },
});
`);

        expect(discoverMutatorWrites(newProject(), workdir)).toEqual([]);
    });

    it("attributes multiple replaces across mutators to their exports", () => {
        expect.assertions(1);

        writeMutators(`import { defineMutator } from "@lunora/server";

export const renameChannel = defineMutator({
    server: async (ctx, args) => {
        await ctx.db.replace(args.id, { name: args.name });
    },
});

export const archiveChannel = defineMutator({
    server: async (ctx, args) => {
        const row = await ctx.db.get(args.id);
        await ctx.db.replace(args.id, { ...row, archived: true });
    },
});
`);

        expect(discoverMutatorWrites(newProject(), workdir)).toEqual([
            { exportName: "renameChannel", file: "lunora/mutators.ts", line: 5 },
            { exportName: "archiveChannel", file: "lunora/mutators.ts", line: 12 },
        ]);
    });

    it("ignores a local defineMutator not imported from @lunora/server", () => {
        expect.assertions(1);

        writeMutators(`const defineMutator = (config) => config;

export const renameChannel = defineMutator({
    server: async (ctx, args) => {
        await ctx.db.replace(args.id, { name: args.name });
    },
});
`);

        expect(discoverMutatorWrites(newProject(), workdir)).toEqual([]);
    });
});
