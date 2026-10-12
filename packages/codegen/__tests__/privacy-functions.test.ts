import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../src/index";

/**
 * Plan 468 §4.2 (Phase 0 re-plan): a function the privacy package builds
 * cannot be re-exported by destructuring its `.functions` bag, because codegen
 * drops it silently when the package ships declarations only. The app declares
 * each function as a builder call in its own file, and the package supplies only
 * the handler. These cases pin the shape the plan uses.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");

let workdir: string;

/** A published-looking package that ships declarations only, as `@lunora/privacy` will. */
const writePackage = (declaration: string): void => {
    const directory = join(workdir, "node_modules", "@fixture", "privacy");

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@fixture/privacy", types: "index.d.ts", main: "index.js", type: "module" }));
    writeFileSync(join(directory, "index.d.ts"), declaration);
    writeFileSync(join(directory, "index.js"), "export {};\n");
};

const apiAfterRun = (): string => {
    runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

    return readFileSync(join(workdir, "lunora", "_generated", "api.ts"), "utf8");
};

describe("privacy functions declared in the app (plan 468 §4.2)", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-privacy-functions-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("registers a mutation whose handler is imported from the package", () => {
        expect.assertions(1);

        writePackage(`export declare const requestExportHandler: (ctx: { params: { subjectId: string } }) => Promise<void>;\n`);
        writeFileSync(
            join(workdir, "lunora", "privacy-api.ts"),
            `import { mutation, v } from "@lunora/server";\nimport { requestExportHandler } from "@fixture/privacy";\n\nexport const requestExport = mutation({ args: { subjectId: v.string() }, handler: requestExportHandler });\n`,
        );

        expect(apiAfterRun()).toContain("requestExport");
    });

    it("registers a mutation whose handler is a property of a package object", () => {
        expect.assertions(1);

        writePackage(`export declare const privacy: { handlers: { requestExport: (ctx: { params: { subjectId: string } }) => Promise<void> } };\n`);
        writeFileSync(
            join(workdir, "lunora", "privacy-api.ts"),
            `import { mutation, v } from "@lunora/server";\nimport { privacy } from "@fixture/privacy";\n\nexport const requestExport = mutation({ args: { subjectId: v.string() }, handler: privacy.handlers.requestExport });\n`,
        );

        expect(apiAfterRun()).toContain("requestExport");
    });
});
