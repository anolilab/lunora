import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverKvKeyAccesses from "../../src/discover/kv-key-accesses";
import type { FunctionIR } from "../../src/ir";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverKvKeyAccesses", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-kv-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a direct ctx.kv.get(args.key)", () => {
        expect.assertions(2);

        write("read.ts", `export const read = query(async ({ ctx, args }) => { return ctx.kv.get(args.key); });`);

        const found = discoverKvKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "read", file: "read", line: 1, method: "get" });
    });

    it("flags a put with an args-derived key", () => {
        expect.assertions(2);

        write("put.ts", `export const save = mutation(async ({ ctx, args }) => { await ctx.kv.put(args.key, args.value); });`);

        const found = discoverKvKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "save", method: "put" });
    });

    it("flags a delete with an args-derived key", () => {
        expect.assertions(2);

        write("del.ts", `export const remove = mutation(async ({ ctx, args }) => { await ctx.kv.delete(args.key); });`);

        const found = discoverKvKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "remove", method: "delete" });
    });

    it("flags an args value reached through one local const hop", () => {
        expect.assertions(1);

        write("hop.ts", `export const save = mutation(async ({ ctx, args }) => { const k = args.key; await ctx.kv.put(k, args.value); });`);

        expect(discoverKvKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a key scoped by a server-trusted ctx value", () => {
        expect.assertions(1);

        write("scoped.ts", `export const read = query(async ({ ctx, args }) => { return ctx.kv.get(\`\${ctx.auth.userId}:\${args.id}\`); });`);

        expect(discoverKvKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a ctx-scoped key reached through one local const hop", () => {
        expect.assertions(1);

        write("scoped-hop.ts", `export const read = query(async ({ ctx, args }) => { const k = \`\${ctx.auth.userId}:\${args.id}\`; return ctx.kv.get(k); });`);

        expect(discoverKvKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a key prefixed by a locally-bound ctx identity (two hops)", () => {
        expect.assertions(1);

        // ctx identity bound to `userId` first, then composed into the key — the
        // identity reaches ctx one hop deeper than the key template itself.
        write(
            "identity-prefix.ts",
            `export const read = query(async ({ ctx, args }) => { const userId = ctx.auth.userId ?? "anon"; const k = \`\${userId}:\${args.id}\`; return ctx.kv.get(k); });`,
        );

        expect(discoverKvKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a fixed literal key", () => {
        expect.assertions(1);

        write("fixed.ts", `export const read = query(async ({ ctx }) => { return ctx.kv.get("feature-flags"); });`);

        expect(discoverKvKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a non-kv receiver with the same method name", () => {
        expect.assertions(1);

        write("other.ts", `export const read = action(async ({ ctx, args }) => { return ctx.storage.x.get(args.key); });`);

        expect(discoverKvKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("attaches the enclosing procedure's visibility when `functions` is supplied", () => {
        expect.assertions(2);

        write("cache.ts", `export const warmCache = internalMutation(async ({ ctx, args }) => { await ctx.kv.put(args.cacheKey, args.blob); });`);

        const functions: FunctionIR[] = [
            { args: {}, exportName: "warmCache", filePath: "cache", kind: "mutation", returnType: "unknown", visibility: "internal" },
        ];
        const found = discoverKvKeyAccesses(project, join(workdir, "lunora"), functions);

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ visibility: "internal" });
    });

    it("leaves visibility undefined when the access can't be attributed to a supplied function", () => {
        expect.assertions(2);

        write("orphan.ts", `export const orphan = query(async ({ ctx, args }) => { return ctx.kv.get(args.key); });`);

        const found = discoverKvKeyAccesses(project, join(workdir, "lunora"), []);

        expect(found).toHaveLength(1);
        expect(found[0]?.visibility).toBeUndefined();
    });

    it("ignores ctx.kv.list (takes a prefix, not a per-entry key)", () => {
        expect.assertions(1);

        write("list.ts", `export const all = query(async ({ ctx, args }) => { return ctx.kv.list({ prefix: args.prefix }); });`);

        expect(discoverKvKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
