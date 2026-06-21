import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectFramework } from "../src/detect-framework";

describe("detectFramework", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-detect-framework-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const writePackageJson = (contents: unknown): void => {
        writeFileSync(join(root, "package.json"), JSON.stringify(contents), "utf8");
    };

    it("returns standalone (class C / none) when no package.json exists", () => {
        expect.assertions(1);

        expect(detectFramework(root)).toStrictEqual({ class: "C", framework: "none" });
    });

    it("returns standalone for an empty dependency set", () => {
        expect.assertions(1);

        writePackageJson({ name: "app" });

        expect(detectFramework(root)).toStrictEqual({ class: "C", framework: "none" });
    });

    it("returns standalone for a malformed package.json rather than throwing", () => {
        expect.assertions(1);

        writeFileSync(join(root, "package.json"), "{ not valid", "utf8");

        expect(detectFramework(root)).toStrictEqual({ class: "C", framework: "none" });
    });

    it.each([
        ["@tanstack/react-start", "A", "tanstack-start"],
        ["@tanstack/solid-start", "A", "tanstack-start-solid"],
        ["@react-router/dev", "A", "react-router"],
        ["@solidjs/start", "A", "solid-start"],
        ["solid-start", "A", "solid-start"],
        ["@sveltejs/kit", "B", "sveltekit"],
        ["nuxt", "B", "nuxt"],
        ["astro", "B", "astro"],
    ])("detects %s as class %s / %s", (dependency, frameworkClass, framework) => {
        expect.assertions(1);

        writePackageJson({ dependencies: { [dependency]: "1.0.0" } });

        expect(detectFramework(root)).toStrictEqual({ class: frameworkClass, framework });
    });

    it("detects a signature declared in devDependencies", () => {
        expect.assertions(1);

        writePackageJson({ devDependencies: { astro: "5.0.0" } });

        expect(detectFramework(root)).toStrictEqual({ class: "B", framework: "astro" });
    });

    it("returns standalone for an unknown framework dependency", () => {
        expect.assertions(1);

        writePackageJson({ dependencies: { next: "15.0.0" } });

        expect(detectFramework(root)).toStrictEqual({ class: "C", framework: "none" });
    });

    it("prefers the first signature in table order when several match", () => {
        expect.assertions(1);

        // Both `@tanstack/react-start` (earlier) and `astro` (later) are present;
        // the table is ordered most-specific-first, so the first match wins.
        writePackageJson({ dependencies: { "@tanstack/react-start": "1.0.0", astro: "5.0.0" } });

        expect(detectFramework(root)).toStrictEqual({ class: "A", framework: "tanstack-start" });
    });
});
