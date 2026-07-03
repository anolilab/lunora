import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverVectorNamespaceAccesses from "../src/discover-vector-namespace-accesses";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverVectorNamespaceAccesses", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vectors-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a direct ctx.vectors.query namespace from args", () => {
        expect.assertions(2);

        write("search.ts", `export const search = query(async ({ ctx, args }) => { return ctx.vectors.query(idx, { namespace: args.tenant, topK: 5 }); });`);

        const found = discoverVectorNamespaceAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "search", file: "search", line: 1, method: "query" });
    });

    it("flags an upsert with an args-derived namespace", () => {
        expect.assertions(2);

        write(
            "index-doc.ts",
            `export const indexDoc = mutation(async ({ ctx, args }) => { await ctx.vectors.upsert(idx, { namespace: args.tenant, vectors }); });`,
        );

        const found = discoverVectorNamespaceAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "indexDoc", method: "upsert" });
    });

    it("flags an args namespace reached through one local const hop", () => {
        expect.assertions(1);

        write("hop.ts", `export const search = query(async ({ ctx, args }) => { const ns = args.tenant; return ctx.vectors.query(idx, { namespace: ns }); });`);

        expect(discoverVectorNamespaceAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a namespace scoped by a server-trusted ctx value", () => {
        expect.assertions(1);

        write("scoped.ts", `export const search = query(async ({ ctx, args }) => { return ctx.vectors.query(idx, { namespace: \`\${ctx.auth.orgId}\` }); });`);

        expect(discoverVectorNamespaceAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a fixed literal namespace", () => {
        expect.assertions(1);

        write("fixed.ts", `export const search = query(async ({ ctx }) => { return ctx.vectors.query(idx, { namespace: "global" }); });`);

        expect(discoverVectorNamespaceAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a call with no namespace property", () => {
        expect.assertions(1);

        write("no-namespace.ts", `export const search = query(async ({ ctx, args }) => { return ctx.vectors.query(idx, { topK: 5 }); });`);

        expect(discoverVectorNamespaceAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a non-vectors receiver with the same method name", () => {
        expect.assertions(1);

        write("other.ts", `export const search = query(async ({ ctx, args }) => { return ctx.search.query(idx, { namespace: args.tenant }); });`);

        expect(discoverVectorNamespaceAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
