import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Node, Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import discoverBrowserUrlAccesses from "../../src/discover/browser-url-accesses";

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
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "grab" }, file: "shot", line: 1, method: "screenshot" });
    });

    it("flags a destructured `args` url — the form the browser registry item ships", () => {
        expect.assertions(2);

        write(
            "destructured.ts",
            `export const grab = action.input({ url: v.string() }).action(async ({ args: { url }, ctx }) => ctx.browser.screenshot(assertAllowedTarget(url)));`,
        );

        const found = discoverBrowserUrlAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "grab" }, file: "destructured", method: "screenshot" });
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

    it("does not walk a lib declaration file to resolve a global the url passes through", () => {
        expect.assertions(2);

        // The `browser` registry item validates the url through `new URL(url)`,
        // and `URL` is a `declare var` in `lib.dom.d.ts`. Following it asked
        // whether that `var` is reassigned, which walked every identifier of the
        // ~40k-line lib file: ~1s per codegen run, ~15s under v8 coverage — the
        // CLI registry sweep timed out on exactly this.
        write("parsed.ts", `export const grab = action(async ({ ctx, args }) => ctx.browser.pdf(new URL(args.url).href));`);

        const walks = vi.spyOn(Node.prototype, "getDescendantsOfKind");

        try {
            expect(discoverBrowserUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
            expect(walks.mock.contexts.filter((node) => (node as Node).getSourceFile().isDeclarationFile())).toStrictEqual([]);
        } finally {
            walks.mockRestore();
        }
    });

    it("ignores a ctx.browser method that is not a URL-navigation method", () => {
        expect.assertions(1);

        write("close.ts", `export const grab = action(async ({ ctx, args }) => { return ctx.browser.close(args.url); });`);

        expect(discoverBrowserUrlAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
