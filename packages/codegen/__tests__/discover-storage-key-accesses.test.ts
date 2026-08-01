import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverStorageKeyAccesses from "../src/discover-storage-key-accesses";
import type { FunctionIR } from "../src/ir";

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

    // Issue #284: `storage_key_from_user_args` had no reachability model — both
    // real-world false positives were `internalAction`s receiving a
    // content-addressed storage id minted server-side.
    it("ignores a key rebuilt by an intervening call (content-addressed, not caller-controlled)", () => {
        expect.assertions(1);

        write(
            "extraction.ts",
            `export const extractDocumentText = internalAction(async ({ ctx, args }) => { return ctx.storage.docs.getUrl(hashOf(args.storageId)); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a key reached through one local hop to an intervening call", () => {
        expect.assertions(1);

        write(
            "hop-call.ts",
            `export const extractDocumentText = internalAction(async ({ ctx, args }) => {
                const key = hashOf(args.storageId);
                return ctx.storage.docs.getUrl(key);
            });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("attaches the enclosing procedure's visibility when `functions` is supplied", () => {
        expect.assertions(2);

        write("extraction2.ts", `export const extractDocumentText = internalAction(async ({ ctx, args }) => { return ctx.storage.docs.get(args.storageId); });`);

        const functions: FunctionIR[] = [
            { args: {}, exportName: "extractDocumentText", filePath: "extraction2", kind: "action", returnType: "unknown", visibility: "internal" },
        ];
        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"), functions);

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ visibility: "internal" });
    });

    it("leaves visibility undefined when the access can't be attributed to a supplied function", () => {
        expect.assertions(2);

        write("orphan.ts", `export const orphan = query(async ({ ctx, args }) => { return ctx.storage.docs.get(args.storageId); });`);

        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"), []);

        expect(found).toHaveLength(1);
        expect(found[0]?.visibility).toBeUndefined();
    });
});
