import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverStorageKeyAccesses from "../src/discover-storage-key-accesses";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverStorageKeyAccesses", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-storage-key-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a direct ctx.storage.<bucket>.get(args.key)", () => {
        expect.assertions(2);

        write("read.ts", `export const read = query(async ({ ctx, args }) => { return ctx.storage.avatars.get(args.key); });`);

        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "read", file: "read", line: 1, method: "get" });
    });

    it("flags a put with an args-derived key", () => {
        expect.assertions(2);

        write("upload.ts", `export const upload = mutation(async ({ ctx, args }) => { await ctx.storage.docs.put(args.name, args.body); });`);

        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "upload", method: "put" });
    });

    it("flags a delete with an args-derived key", () => {
        expect.assertions(2);

        write("remove.ts", `export const remove = mutation(async ({ ctx, args }) => { await ctx.storage.docs.delete(args.key); });`);

        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "remove", method: "delete" });
    });

    it("flags an args key reached through one local const hop", () => {
        expect.assertions(1);

        write("hop.ts", `export const save = mutation(async ({ ctx, args }) => { const k = args.key; await ctx.storage.docs.put(k, args.body); });`);

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a default-bucket call (ctx.storage.download(args.key))", () => {
        expect.assertions(2);

        write("dl.ts", `export const grab = action(async ({ ctx, args }) => { return ctx.storage.download(args.key); });`);

        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "grab", method: "download" });
    });

    it("ignores a ctx-scoped key reached through one local const hop", () => {
        expect.assertions(1);

        write(
            "scoped-hop.ts",
            `export const save = mutation(async ({ ctx, args }) => { const k = \`\${ctx.auth.userId}/\${args.name}\`; await ctx.storage.avatars.put(k, args.body); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a key scoped by a server-trusted ctx value", () => {
        expect.assertions(1);

        write(
            "scoped.ts",
            `export const save = mutation(async ({ ctx, args }) => { await ctx.storage.avatars.put(\`\${ctx.auth.userId}/\${args.name}\`, args.body); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a key prefixed by a locally-bound ctx identity (two hops)", () => {
        expect.assertions(1);

        // The recommended remediation, written idiomatically: the identity reaches ctx
        // only through the `userId` binding, one hop deeper than the key template — so
        // `avatars/${userId}/${args.key}` is scoped, not attacker-controlled.
        write(
            "identity-prefix.ts",
            `export const uploadAvatar = action(async ({ ctx, args }) => {
                const userId = ctx.auth.userId ?? "anonymous";
                const scopedKey = \`avatars/\${userId}/\${args.key}\`;
                return ctx.storage.avatars.generateUploadUrl(scopedKey, { contentType: args.contentType });
            });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a fixed literal key", () => {
        expect.assertions(1);

        write("fixed.ts", `export const logo = query(async ({ ctx }) => { return ctx.storage.assets.get("logo.png"); });`);

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a non-storage receiver (ctx.kv)", () => {
        expect.assertions(1);

        write("kv.ts", `export const cached = query(async ({ ctx, args }) => { return ctx.kv.get(args.key); });`);

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a list call (a key prefix, not a per-object key)", () => {
        expect.assertions(1);

        write("browse.ts", `export const browse = query(async ({ ctx, args }) => { return ctx.storage.docs.list(args.prefix); });`);

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
