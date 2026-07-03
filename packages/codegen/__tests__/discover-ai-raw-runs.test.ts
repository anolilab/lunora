import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverAiRawRuns from "../src/discover-ai-raw-runs";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverAiRawRuns", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-ai-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a direct ctx.ai.run(args.model, {})", () => {
        expect.assertions(2);

        write("run.ts", `export const infer = action(async ({ ctx, args }) => { return ctx.ai.run(args.model, {}); });`);

        const found = discoverAiRawRuns(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "infer", file: "run", line: 1 });
    });

    it("flags an args-derived model reached through one local const hop", () => {
        expect.assertions(1);

        write("hop.ts", `export const infer = action(async ({ ctx, args }) => { const m = args.model; return ctx.ai.run(m, {}); });`);

        expect(discoverAiRawRuns(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a fixed model with an args-derived inputs argument", () => {
        expect.assertions(1);

        write("inputs.ts", `export const infer = action(async ({ ctx, args }) => { return ctx.ai.run("@cf/meta/llama-3", args.inputs); });`);

        expect(discoverAiRawRuns(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a model scoped by a server-trusted ctx value", () => {
        expect.assertions(1);

        write("scoped.ts", `export const infer = action(async ({ ctx, args }) => { return ctx.ai.run(ctx.config.model, args.inputs); });`);

        expect(discoverAiRawRuns(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a ctx-scoped model reached through one local const hop", () => {
        expect.assertions(1);

        write("scoped-hop.ts", `export const infer = action(async ({ ctx, args }) => { const m = ctx.config.model; return ctx.ai.run(m, args.inputs); });`);

        expect(discoverAiRawRuns(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a fixed literal model", () => {
        expect.assertions(1);

        write("fixed.ts", `export const infer = action(async ({ ctx }) => { return ctx.ai.run("@cf/meta/llama-3", {}); });`);

        expect(discoverAiRawRuns(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a non-ai receiver with the same method name", () => {
        expect.assertions(1);

        write("other.ts", `export const infer = action(async ({ ctx, args }) => { return foo.run(args.model); });`);

        expect(discoverAiRawRuns(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
