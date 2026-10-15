import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverVectorNamespaceAccesses from "../../src/discover/vector-namespace-accesses";

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
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "search" }, file: "search", line: 1, method: "query" });
    });

    it("flags an upsert with an args-derived namespace", () => {
        expect.assertions(2);

        write(
            "index-doc.ts",
            `export const indexDoc = mutation(async ({ ctx, args }) => { await ctx.vectors.upsert(idx, { namespace: args.tenant, vectors }); });`,
        );

        const found = discoverVectorNamespaceAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "indexDoc" }, method: "upsert" });
    });

    it("flags an upsertNow with an args-derived namespace", () => {
        expect.assertions(2);

        write(
            "index-now.ts",
            `export const indexNow = mutation(async ({ ctx, args }) => { await ctx.vectors.upsertNow(idx, { namespace: args.tenant, embed, id: "a", input: "x" }); });`,
        );

        const found = discoverVectorNamespaceAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "indexNow" }, method: "upsertNow" });
    });

    it("flags an upsertMany whose element namespace comes from args", () => {
        expect.assertions(2);

        write(
            "index-many.ts",
            `export const indexMany = mutation(async ({ ctx, args }) => { await ctx.vectors.upsertMany(idx, [{ namespace: \`\${ctx.auth.orgId}\`, embed, id: "a", input: "x" }, { namespace: args.tenant, embed, id: "b", input: "y" }]); });`,
        );

        const found = discoverVectorNamespaceAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "indexMany" }, method: "upsertMany" });
    });

    it.each([
        ["shorthand", `const namespace = args.tenant; await ctx.vectors.upsertMany(idx, [{ namespace, embed, id: "a", input: "x" }]);`],
        ["spread", `const records = [{ namespace: args.tenant, embed, id: "a", input: "x" }]; await ctx.vectors.upsertMany(idx, [...records]);`],
        ["map", `await ctx.vectors.upsertMany(idx, args.rows.map((row) => ({ namespace: args.tenant, embed, id: row.id, input: row.text })));`],
        ["map block", `await ctx.vectors.upsertMany(idx, args.rows.map((row) => { return { namespace: args.tenant, embed, id: row.id, input: row.text }; }));`],
        ["variable array", `const records = [{ namespace: args.tenant, embed, id: "a", input: "x" }]; await ctx.vectors.upsertMany(idx, records);`],
        [
            "variable map",
            `const records = args.rows.map((row) => ({ namespace: args.tenant, embed, id: row.id })); await ctx.vectors.upsertMany(idx, records);`,
        ],
        ["identifier element", `const record = { namespace: args.tenant, embed, id: "a", input: "x" }; await ctx.vectors.upsertMany(idx, [record]);`],
        [
            "map callback parameter",
            `await ctx.vectors.upsertMany(idx, args.rows.map((row) => ({ namespace: row.tenant, embed, id: row.id, input: row.text })));`,
        ],
        [
            "map destructured parameter",
            `await ctx.vectors.upsertMany(idx, args.rows.map(({ tenant }) => ({ namespace: tenant, embed, id: "a", input: "x" })));`,
        ],
    ])("flags an arg-derived upsertMany namespace (%s)", (_name, body) => {
        expect.assertions(1);

        write("many.ts", `export const indexMany = mutation(async ({ ctx, args }) => { ${body} });`);

        expect(discoverVectorNamespaceAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["shorthand", `const namespace = \`\${ctx.auth.orgId}\`; await ctx.vectors.upsertMany(idx, [{ namespace, embed, id: "a", input: "x" }]);`],
        ["spread", `const records = [{ namespace: \`\${ctx.auth.orgId}\`, embed, id: "a" }]; await ctx.vectors.upsertMany(idx, [...records]);`],
        ["map", `await ctx.vectors.upsertMany(idx, args.rows.map((row) => ({ namespace: \`\${ctx.auth.orgId}\`, embed, id: row.id })));`],
        ["map block", `await ctx.vectors.upsertMany(idx, args.rows.map((row) => { return { namespace: \`\${ctx.auth.orgId}\`, embed, id: row.id }; }));`],
        ["variable array", `const records = [{ namespace: \`\${ctx.auth.orgId}\`, embed, id: "a" }]; await ctx.vectors.upsertMany(idx, records);`],
        [
            "variable map",
            `const records = args.rows.map((row) => ({ namespace: \`\${ctx.auth.orgId}\`, embed, id: row.id })); await ctx.vectors.upsertMany(idx, records);`,
        ],
        ["identifier element", `const record = { namespace: \`\${ctx.auth.orgId}\`, embed, id: "a" }; await ctx.vectors.upsertMany(idx, [record]);`],
        ["map callback parameter", `await ctx.vectors.upsertMany(idx, args.rows.map((row) => ({ namespace: ctx.identity.orgId, embed, id: row.id })));`],
        [
            "map over a local array",
            `const rows = [{ id: "a" }]; await ctx.vectors.upsertMany(idx, rows.map((row) => ({ namespace: row.id, embed, id: row.id })));`,
        ],
    ])("ignores a ctx-scoped upsertMany namespace (%s)", (_name, body) => {
        expect.assertions(1);

        write("many-scoped.ts", `export const indexMany = mutation(async ({ ctx, args }) => { ${body} });`);

        expect(discoverVectorNamespaceAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores an upsertMany whose every element namespace is scoped by ctx", () => {
        expect.assertions(1);

        write(
            "scoped-many.ts",
            `export const indexMany = mutation(async ({ ctx, args }) => { await ctx.vectors.upsertMany(idx, [{ namespace: \`\${ctx.auth.orgId}\`, embed, id: "a", input: "x" }]); });`,
        );

        expect(discoverVectorNamespaceAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
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
