import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverStorageUploads from "../src/discover-storage-uploads";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverStorageUploads", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-storage-uploads-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records an upload() with no options argument as analyzable with no keys", () => {
        expect.assertions(2);

        write("upload.ts", `export const save = action(async ({ ctx }) => ctx.storage.avatars.upload("k", body));`);

        const found = discoverStorageUploads(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ analyzable: true, exportName: "save", method: "upload", presentKeys: [] });
    });

    it("records the present option keys on an upload() options object (arg index 2)", () => {
        expect.assertions(1);

        write(
            "guarded.ts",
            `export const save = action(async ({ ctx }) =>
    ctx.storage.avatars.upload("k", body, { allowedContentTypes: ["image/png"], maxSize: 1024 }));`,
        );

        const [row] = discoverStorageUploads(project, join(workdir, "lunora"));

        expect(row?.presentKeys).toStrictEqual(["allowedContentTypes", "maxSize"]);
    });

    it("reads generateUploadUrl's options from argument index 1", () => {
        expect.assertions(2);

        write("sign.ts", `export const url = action(async ({ ctx }) => ctx.storage.avatars.generateUploadUrl("k", { contentType: "image/png" }));`);

        const [row] = discoverStorageUploads(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ method: "generateUploadUrl" });
        expect(row?.presentKeys).toStrictEqual(["contentType"]);
    });

    it("captures a statically-known expiresInSeconds literal on getPresignedUrl", () => {
        expect.assertions(1);

        write("presign.ts", `export const url = action(async ({ ctx }) => ctx.storage.docs.getPresignedUrl("k", { expiresInSeconds: 604800 }));`);

        const [row] = discoverStorageUploads(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ expiresInSeconds: 604_800, method: "getPresignedUrl", presentKeys: ["expiresInSeconds"] });
    });

    it("marks a spread options object as not analyzable", () => {
        expect.assertions(1);

        write("spread.ts", `export const save = action(async ({ ctx }) => ctx.storage.avatars.upload("k", body, { ...opts, maxSize: 1 }));`);

        const [row] = discoverStorageUploads(project, join(workdir, "lunora"));

        expect(row?.analyzable).toBe(false);
    });

    it("marks a non-object-literal options argument (a variable) as not analyzable", () => {
        expect.assertions(1);

        write("opaque.ts", `export const save = action(async ({ ctx }) => ctx.storage.avatars.upload("k", body, opts));`);

        const [row] = discoverStorageUploads(project, join(workdir, "lunora"));

        expect(row?.analyzable).toBe(false);
    });

    it("does not track a tracked method name on an unrelated receiver", () => {
        expect.assertions(1);

        write("plain.ts", `export const a = action(async ({ ctx }) => ctx.db.query("users").upload("x"));`);

        expect(discoverStorageUploads(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
