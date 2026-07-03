import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverBrowserUrlAccesses from "../src/discover-browser-url-accesses";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverBrowserUrlAccesses", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-browser-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a direct ctx.browser.screenshot(args.url)", () => {
        expect.assertions(2);

        write("shot.ts", `export const grab = action(async ({ ctx, args }) => { return ctx.browser.screenshot(args.url); });`);

        const found = discoverBrowserUrlAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "grab", file: "shot", line: 1, method: "screenshot" });
    });

    it("flags each of pdf/content/scrape with an args-derived url", () => {
        expect.assertions(1);

        write(
            "each.ts",
            `export const a = action(async ({ ctx, args }) => ctx.browser.pdf(args.url));
export const b = action(async ({ ctx, args }) => ctx.browser.content(args.url));
export const c = action(async ({ ctx, args }) => ctx.browser.scrape(args.url));`,
        );

        expect(discoverBrowserUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(3);
    });

    it("flags an args-derived url reached through one local const hop", () => {
        expect.assertions(1);

        write("hop.ts", `export const grab = action(async ({ ctx, args }) => { const u = args.url; return ctx.browser.pdf(u); });`);

        expect(discoverBrowserUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a url scoped by a server-trusted ctx value", () => {
        expect.assertions(1);

        write("scoped.ts", `export const grab = action(async ({ ctx }) => { return ctx.browser.screenshot(ctx.config.baseUrl); });`);

        expect(discoverBrowserUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a fixed literal url", () => {
        expect.assertions(1);

        write("fixed.ts", `export const grab = action(async ({ ctx }) => { return ctx.browser.screenshot("https://example.com"); });`);

        expect(discoverBrowserUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a non-browser receiver with the same method name", () => {
        expect.assertions(1);

        write("other.ts", `export const grab = action(async ({ ctx, args }) => { return foo.screenshot(args.url); });`);

        expect(discoverBrowserUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a ctx.browser method that is not a URL-navigation method", () => {
        expect.assertions(1);

        write("close.ts", `export const grab = action(async ({ ctx, args }) => { return ctx.browser.close(args.url); });`);

        expect(discoverBrowserUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
