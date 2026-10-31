import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project, SyntaxKind } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverFunctions from "../../src/discover/functions";
import mayReadIp from "../../src/discover/ip-reads";
import { emitFunctions } from "../../src/emit";

/**
 * A query that may read `ctx.ip` is marked from the source, so the shard never resumes it warm even on its first
 * run, before any dispatch has taught it. The analysis fails closed: what it cannot read counts as a read.
 */
let workdir: string;

describe("discoverFunctions — queries that may read ctx.ip", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-ip-reads-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const readsIpFor = (body: string, imports = ""): boolean | undefined => {
        const full = join(workdir, "feed.ts");

        mkdirSync(workdir, { recursive: true });
        writeFileSync(
            full,
            `import { query } from "@lunora/server";\n${imports}\nexport const list = query({ args: {}, handler: async (ctx) => {\n${body}\n} });\n`,
        );

        const [entry] = discoverFunctions(new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false }), workdir);

        return entry?.readsIp;
    };

    it.each([
        ["a direct read", "return ctx.ip;"],
        ["a destructured read", "const { ip } = ctx; return ip;"],
        ["a read behind an alias", "const c = ctx; return c.ip;"],
        ["a computed key", "const key = 'i' + 'p'; return (ctx as any)[key];"],
        ["a rest that could hold it", "const { db, ...rest } = ctx; return rest;"],
        ["the ctx handed to a helper", "return helper(ctx);"],
        ["another function run on the same caller", "return ctx.runQuery(other, {});"],
    ])("marks %s", (_name, body) => {
        expect.assertions(1);

        expect(readsIpFor(body, "declare const helper: (ctx: unknown) => unknown;\ndeclare const other: any;")).toBe(true);
    });

    it("marks a handler passed by reference, whose body this file does not show", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "feed.ts"),
            `import { query } from "@lunora/server";\nconst handler = async (ctx: any) => ctx.ip;\nexport const list = query({ args: {}, handler });\n`,
        );

        const [entry] = discoverFunctions(new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false }), workdir);

        expect(entry?.readsIp).toBe(true);
    });

    it("marks a middleware added through bracket access", () => {
        expect.assertions(1);

        const source = new Project({ useInMemoryFileSystem: true }).createSourceFile(
            "feed.ts",
            `declare const query: any;\ndeclare const byAddress: any;\nexport const list = query["use"](byAddress).query(async (ctx: any) => ctx.db);\n`,
        );
        const call = source.getVariableDeclarationOrThrow("list").getInitializerIfKindOrThrow(SyntaxKind.CallExpression);

        expect(mayReadIp(call)).toBe(true);
    });

    it("leaves a query that only reads its database unmarked", () => {
        expect.assertions(1);

        expect(readsIpFor("return ctx.db.query('messages').collect();")).toBeUndefined();
    });

    it("emits the marked shapes in the same registry", () => {
        expect.assertions(1);

        const emitted = emitFunctions({
            functions: [],
            shapes: [{ args: {}, exportName: "geoRoom", filePath: "shapes", readsIp: true }],
        });

        expect(emitted).toMatch(/LUNORA_IP_READER_PATHS[^\n]*new Set\(\["geoRoom"\]\)/u);
    });

    it("emits the marked queries as a registry the shard seeds its address-keyed set from", () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "feed.ts"),
            `import { query } from "@lunora/server";\nexport const list = query({ args: {}, handler: async (ctx) => ctx.ip });\n`,
        );

        const functions = discoverFunctions(new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false }), workdir);
        const emitted = emitFunctions({ functions });

        expect(emitted).toContain("LUNORA_IP_READER_PATHS");
        expect(emitted).toContain('"feed:list"');
    });
});
