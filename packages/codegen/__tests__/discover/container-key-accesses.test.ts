import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverContainerKeyAccesses from "../src/discover-container-key-accesses";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverContainerKeyAccesses", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-container-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a direct ctx.containers.app.get(args.id)", () => {
        expect.assertions(2);

        write("start.ts", `export const start = mutation(async ({ ctx, args }) => { return ctx.containers.app.get(args.id); });`);

        const found = discoverContainerKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "start", file: "start", line: 1, method: "get" });
    });

    it("flags an args value reached through one local const hop", () => {
        expect.assertions(1);

        write("hop.ts", `export const start = mutation(async ({ ctx, args }) => { const k = args.id; return ctx.containers.app.get(k); });`);

        expect(discoverContainerKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a key scoped by a server-trusted ctx value", () => {
        expect.assertions(1);

        write("scoped.ts", `export const start = mutation(async ({ ctx, args }) => { return ctx.containers.app.get(\`\${ctx.auth.userId}\`); });`);

        expect(discoverContainerKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a ctx-scoped key reached through one local const hop", () => {
        expect.assertions(1);

        write(
            "scoped-hop.ts",
            `export const start = mutation(async ({ ctx, args }) => { const k = \`\${ctx.auth.userId}\`; return ctx.containers.app.get(k); });`,
        );

        expect(discoverContainerKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a fixed literal key", () => {
        expect.assertions(1);

        write("fixed.ts", `export const start = mutation(async ({ ctx }) => { return ctx.containers.app.get("singleton"); });`);

        expect(discoverContainerKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores ctx.containers.app.any() and .pool() (no key argument)", () => {
        expect.assertions(1);

        write(
            "pool.ts",
            `export const start = mutation(async ({ ctx, args }) => { ctx.containers.app.any(); return ctx.containers.app.pool({ options: args.options }); });`,
        );

        expect(discoverContainerKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a non-container receiver with the same method name", () => {
        expect.assertions(1);

        write("other.ts", `export const start = mutation(async ({ ctx, args }) => { return foo.get(args.id); });`);

        expect(discoverContainerKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
