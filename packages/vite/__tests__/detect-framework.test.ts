import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectFramework } from "../src/detect-framework";

let workdir: string;

/** Write a `package.json` into the temp project root. */
const writePackageJson = (root: string, packageJson: Record<string, unknown>): void => {
    writeFileSync(join(root, "package.json"), JSON.stringify(packageJson, null, 4), "utf8");
};

describe("detectFramework", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-detect-framework-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("single-framework detection (class A)", () => {
        it("detects TanStack Start from dependencies", () => {
            expect.assertions(1);

            writePackageJson(workdir, { dependencies: { "@tanstack/react-start": "^1.0.0" } });

            expect(detectFramework(workdir)).toStrictEqual({ class: "A", framework: "tanstack-start" });
        });

        it("detects React Router from @react-router/dev", () => {
            expect.assertions(1);

            writePackageJson(workdir, { devDependencies: { "@react-router/dev": "^7.0.0" } });

            expect(detectFramework(workdir)).toStrictEqual({ class: "A", framework: "react-router" });
        });

        it("detects SolidStart from @solidjs/start", () => {
            expect.assertions(1);

            writePackageJson(workdir, { dependencies: { "@solidjs/start": "^1.0.0" } });

            expect(detectFramework(workdir)).toStrictEqual({ class: "A", framework: "solid-start" });
        });

        it("detects SolidStart from the legacy solid-start package", () => {
            expect.assertions(1);

            writePackageJson(workdir, { dependencies: { "solid-start": "^0.3.0" } });

            expect(detectFramework(workdir)).toStrictEqual({ class: "A", framework: "solid-start" });
        });
    });

    describe("single-framework detection (class B)", () => {
        it("detects SvelteKit from @sveltejs/kit", () => {
            expect.assertions(1);

            writePackageJson(workdir, { devDependencies: { "@sveltejs/kit": "^2.0.0" } });

            expect(detectFramework(workdir)).toStrictEqual({ class: "B", framework: "sveltekit" });
        });

        it("detects Nuxt from nuxt", () => {
            expect.assertions(1);

            writePackageJson(workdir, { devDependencies: { nuxt: "^3.0.0" } });

            expect(detectFramework(workdir)).toStrictEqual({ class: "B", framework: "nuxt" });
        });

        it("detects Astro from astro", () => {
            expect.assertions(1);

            writePackageJson(workdir, { dependencies: { astro: "^5.0.0" } });

            expect(detectFramework(workdir)).toStrictEqual({ class: "B", framework: "astro" });
        });
    });

    describe("dependencies vs devDependencies", () => {
        it("checks dependencies", () => {
            expect.assertions(1);

            writePackageJson(workdir, { dependencies: { "@sveltejs/kit": "^2.0.0" } });

            expect(detectFramework(workdir).framework).toBe("sveltekit");
        });

        it("checks devDependencies", () => {
            expect.assertions(1);

            writePackageJson(workdir, { devDependencies: { astro: "^5.0.0" } });

            expect(detectFramework(workdir).framework).toBe("astro");
        });
    });

    describe("the none case", () => {
        it("returns none + class C when no framework dependency is present", () => {
            expect.assertions(1);

            writePackageJson(workdir, { dependencies: { react: "^19.0.0" }, name: "plain-spa" });

            expect(detectFramework(workdir)).toStrictEqual({ class: "C", framework: "none" });
        });

        it("returns none when package.json has no dependency fields at all", () => {
            expect.assertions(1);

            writePackageJson(workdir, { name: "empty", version: "1.0.0" });

            expect(detectFramework(workdir)).toStrictEqual({ class: "C", framework: "none" });
        });
    });

    describe("edge cases (never throws)", () => {
        it("returns none when package.json is missing", () => {
            expect.assertions(1);

            // workdir exists but contains no package.json.
            expect(detectFramework(workdir)).toStrictEqual({ class: "C", framework: "none" });
        });

        it("returns none when package.json is malformed JSON", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "package.json"), "{ not valid json", "utf8");

            expect(detectFramework(workdir)).toStrictEqual({ class: "C", framework: "none" });
        });

        it("returns none when package.json is not an object", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "package.json"), '"a string"', "utf8");

            expect(detectFramework(workdir)).toStrictEqual({ class: "C", framework: "none" });
        });

        it("returns none when the root directory does not exist", () => {
            expect.assertions(1);

            expect(detectFramework(join(workdir, "does", "not", "exist"))).toStrictEqual({ class: "C", framework: "none" });
        });
    });

    describe("precedence when multiple frameworks coexist", () => {
        it("prefers TanStack Start over React Router", () => {
            expect.assertions(1);

            writePackageJson(workdir, {
                dependencies: { "@react-router/dev": "^7.0.0", "@tanstack/react-start": "^1.0.0" },
            });

            expect(detectFramework(workdir).framework).toBe("tanstack-start");
        });

        it("prefers a class-A framework over a class-B one regardless of dep section", () => {
            expect.assertions(1);

            writePackageJson(workdir, {
                dependencies: { astro: "^5.0.0" },
                devDependencies: { "@react-router/dev": "^7.0.0" },
            });

            expect(detectFramework(workdir).framework).toBe("react-router");
        });

        it("prefers SvelteKit over Nuxt over Astro (class-B ordering)", () => {
            expect.assertions(1);

            writePackageJson(workdir, {
                devDependencies: { astro: "^5.0.0", nuxt: "^3.0.0", "@sveltejs/kit": "^2.0.0" },
            });

            expect(detectFramework(workdir).framework).toBe("sveltekit");
        });
    });
});
