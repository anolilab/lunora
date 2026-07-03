import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverArgumentDerivedFetches from "../src/discover-argument-derived-fetches";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverArgumentDerivedFetches", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-fetch-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a direct ctx.fetch(args.url)", () => {
        expect.assertions(2);

        write("proxy.ts", `export const proxy = action(async ({ ctx, args }) => { await ctx.fetch(args.url); });`);

        const found = discoverArgumentDerivedFetches(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "proxy", file: "proxy", line: 1 });
    });

    it("flags a URL built from a template embedding args", () => {
        expect.assertions(1);

        write("tpl.ts", `export const proxy = action(async ({ ctx, args }) => { await ctx.fetch(\`https://\${args.host}/x\`); });`);

        expect(discoverArgumentDerivedFetches(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a URL wrapped in new URL(args.url)", () => {
        expect.assertions(1);

        write("url.ts", `export const proxy = action(async ({ ctx, args }) => { await ctx.fetch(new URL(args.url)); });`);

        expect(discoverArgumentDerivedFetches(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags an args value reached through one local const hop", () => {
        expect.assertions(1);

        write("hop.ts", `export const proxy = action(async ({ ctx, args }) => { const target = args.url; await ctx.fetch(target); });`);

        expect(discoverArgumentDerivedFetches(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags an element-access args reference", () => {
        expect.assertions(1);

        write("bracket.ts", `export const proxy = action(async ({ ctx, args }) => { await ctx.fetch(args["url"]); });`);

        expect(discoverArgumentDerivedFetches(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a fixed literal URL", () => {
        expect.assertions(1);

        write("fixed.ts", `export const ping = action(async ({ ctx }) => { await ctx.fetch("https://api.example.com/health"); });`);

        expect(discoverArgumentDerivedFetches(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a URL built from config / ctx, not args", () => {
        expect.assertions(1);

        write("config.ts", `export const sync = action(async ({ ctx }) => { await ctx.fetch(ctx.env.UPSTREAM_URL); });`);

        expect(discoverArgumentDerivedFetches(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores fetch calls whose receiver is not ctx", () => {
        expect.assertions(1);

        write("other.ts", `export const a = action(async ({ ctx, args }) => { await client.fetch(args.url); await fetch(args.url); });`);

        expect(discoverArgumentDerivedFetches(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
