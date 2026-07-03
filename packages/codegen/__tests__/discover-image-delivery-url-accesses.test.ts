import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverImageDeliveryUrlAccesses from "../src/discover-image-delivery-url-accesses";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverImageDeliveryUrlAccesses", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-images-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a direct buildImageDeliveryUrl({ key: args.url })", () => {
        expect.assertions(2);

        write(
            "deliver.ts",
            `export const url = query(async ({ ctx, args }) => { return buildImageDeliveryUrl({ baseUrl: ctx.config.cdn, key: args.url }); });`,
        );

        const found = discoverImageDeliveryUrlAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "url", file: "deliver", line: 1 });
    });

    it("flags an args-derived key reached through one local const hop", () => {
        expect.assertions(1);

        write(
            "hop.ts",
            `export const url = query(async ({ ctx, args }) => { const k = args.url; return buildImageDeliveryUrl({ baseUrl: ctx.config.cdn, key: k }); });`,
        );

        expect(discoverImageDeliveryUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a key scoped by a server-trusted ctx value", () => {
        expect.assertions(1);

        write(
            "scoped.ts",
            `export const url = query(async ({ ctx }) => { return buildImageDeliveryUrl({ baseUrl: ctx.config.cdn, key: ctx.auth.userId }); });`,
        );

        expect(discoverImageDeliveryUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a fixed literal key", () => {
        expect.assertions(1);

        write("fixed.ts", `export const url = query(async ({ ctx }) => { return buildImageDeliveryUrl({ baseUrl: ctx.config.cdn, key: "logo.png" }); });`);

        expect(discoverImageDeliveryUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a call to an unrelated function with the same options shape", () => {
        expect.assertions(1);

        write("other.ts", `export const url = query(async ({ args }) => { return buildOtherUrl({ key: args.url }); });`);

        expect(discoverImageDeliveryUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores an args-derived imageId (not a URL source)", () => {
        expect.assertions(1);

        write("id.ts", `export const url = query(async ({ ctx, args }) => { return buildImageDeliveryUrl({ baseUrl: ctx.config.cdn, imageId: args.id }); });`);

        expect(discoverImageDeliveryUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a shorthand { key } property", () => {
        expect.assertions(1);

        write(
            "shorthand.ts",
            `export const url = query(async ({ ctx, args }) => { const key = args.url; return buildImageDeliveryUrl({ baseUrl: ctx.config.cdn, key }); });`,
        );

        expect(discoverImageDeliveryUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
