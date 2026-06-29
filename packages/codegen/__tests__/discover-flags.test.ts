import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverFlagKeys, discoverFlags } from "../src/discover-flags";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeFlags = (source: string): void => {
    writeFileSync(join(workdir, "flags.ts"), source);
};

const writeSource = (relative: string, source: string): void => {
    writeFileSync(join(workdir, relative), source);
};

describe("discover-flags", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-flags-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns undefined when lunora/flags.ts does not exist", () => {
        expect.assertions(1);

        expect(discoverFlags(newProject(), workdir)).toBeUndefined();
    });

    it("reads the binding name from a flagship binding-mode provider", () => {
        expect.assertions(1);

        writeFlags(`
            import { defineFlags } from "@lunora/flags";
            import { flagshipProvider } from "@lunora/flags/providers/flagship";

            export default defineFlags({ provider: flagshipProvider({ binding: "FLAGS" }) });
        `);

        expect(discoverFlags(newProject(), workdir)).toStrictEqual({ bindingName: "FLAGS", mode: "binding", provider: "flagship" });
    });

    it("treats an HTTP-mode flagship provider as flagship with no binding", () => {
        expect.assertions(1);

        writeFlags(`
            import { defineFlags } from "@lunora/flags";
            import { flagshipProvider } from "@lunora/flags/providers/flagship";

            export default defineFlags({ provider: flagshipProvider({ appId: "app-abc", accountId: "acct" }) });
        `);

        expect(discoverFlags(newProject(), workdir)).toStrictEqual({ mode: "http", provider: "flagship" });
    });

    it("classifies any other OpenFeature provider factory as custom", () => {
        expect.assertions(1);

        writeFlags(`
            import { defineFlags } from "@lunora/flags";

            export default defineFlags({ provider: (env) => new SomeProvider(env.KEY) });
        `);

        expect(discoverFlags(newProject(), workdir)).toStrictEqual({ provider: "custom" });
    });

    it("follows a `const config = defineFlags(...); export default config` indirection", () => {
        expect.assertions(1);

        writeFlags(`
            import { defineFlags } from "@lunora/flags";
            import { flagshipProvider } from "@lunora/flags/providers/flagship";

            const config = defineFlags({ provider: flagshipProvider({ binding: "MY_FLAGS" }) });
            export default config;
        `);

        expect(discoverFlags(newProject(), workdir)).toStrictEqual({ bindingName: "MY_FLAGS", mode: "binding", provider: "flagship" });
    });

    it("degrades to a custom provider when the binding name is not a static literal", () => {
        expect.assertions(1);

        writeFlags(`
            import { defineFlags } from "@lunora/flags";
            import { flagshipProvider } from "@lunora/flags/providers/flagship";

            const name = "FLAGS";
            export default defineFlags({ provider: flagshipProvider({ binding: name }) });
        `);

        // The provider is still flagship, but a non-literal binding can't be reconciled
        // into wrangler, so it degrades to HTTP mode (no binding to hint).
        expect(discoverFlags(newProject(), workdir)).toStrictEqual({ mode: "http", provider: "flagship" });
    });

    describe("discoverFlagKeys", () => {
        it("returns nothing when no handler reads a flag", () => {
            expect.assertions(1);

            writeSource("messages.ts", `export const list = () => [];`);

            expect(discoverFlagKeys(newProject(), workdir)).toStrictEqual([]);
        });

        it("discovers each ctx.flags.<type> read with its key and value type, sorted and de-duplicated", () => {
            expect.assertions(1);

            writeSource(
                "posts.ts",
                `export const list = async (ctx) => {
                    if (await ctx.flags.boolean("new-ranking", false)) { /* */ }
                    const hero = await ctx.flags.string("homepage-hero", "control");
                    const limit = await ctx.flags.number("page-size", 20);
                    const cfg = await ctx.flags.object("layout", {});
                    const dupe = await ctx.flags.boolean("new-ranking", true);
                    return [hero, limit, cfg, dupe];
                };`,
            );

            expect(discoverFlagKeys(newProject(), workdir)).toStrictEqual([
                { key: "homepage-hero", type: "string" },
                { key: "layout", type: "object" },
                { key: "new-ranking", type: "boolean" },
                { key: "page-size", type: "number" },
            ]);
        });

        it("discovers ctx.flags.details.<type> reads too", () => {
            expect.assertions(1);

            writeSource("detail.ts", `export const go = async (ctx) => ctx.flags.details.boolean("dark-mode", false);`);

            expect(discoverFlagKeys(newProject(), workdir)).toStrictEqual([{ key: "dark-mode", type: "boolean" }]);
        });

        it("ignores dynamic keys and reads not anchored on the ctx identifier", () => {
            expect.assertions(1);

            writeSource(
                "skip.ts",
                `export const go = async (ctx, other) => {
                    const k = "dynamic";
                    await ctx.flags.boolean(k, false);
                    await other.flags.boolean("not-ctx", false);
                };`,
            );

            expect(discoverFlagKeys(newProject(), workdir)).toStrictEqual([]);
        });
    });
});
