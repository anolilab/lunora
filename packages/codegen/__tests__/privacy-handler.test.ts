import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../src/index";

/**
 * Plan 468 §7 (Phase 0): a `defineWorkflow` whose handler comes from a PACKAGE
 * must register through the real codegen pipeline, while a config imported from
 * a package must be rejected, so apps write the `defineWorkflow({...})` literal.
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

const generate = (): string => {
    runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

    return readFileSync(join(workdir, "lunora", "_generated", "workflows.ts"), "utf8");
};

describe("workflow handler supplied by a package (plan 468 Phase 0)", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-privacy-handler-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("registers a workflow whose handler is a property of an app object that a package supplies", () => {
        expect.assertions(2);

        writePackage(`export declare const exportHandler: (ctx: { params: { userId: string } }) => Promise<void>;\n`);
        writeFileSync(
            join(workdir, "lunora", "privacy.ts"),
            `import { exportHandler } from "@fixture/privacy";\n\nexport const privacy = { exportHandler };\n`,
        );
        writeFileSync(
            join(workdir, "lunora", "workflows.ts"),
            `import { defineWorkflow } from "@lunora/workflow";\nimport { privacy } from "./privacy";\n\nexport const privacyExport = defineWorkflow({ handler: privacy.exportHandler, name: "privacy-export" });\n`,
        );

        const workflows = generate();

        expect(workflows).toContain("export class PrivacyExportWorkflow");
        expect(workflows).toContain('super(ctx, env, privacyExport, "privacyExport");');
    });

    it("registers a workflow whose handler is an app-local property, as the plan's integration sketch writes it", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "privacy.ts"),
            `export const privacy = {\n  exportHandler: async (ctx: { params: { userId: string } }) => {\n    await ctx.params;\n  },\n};\n`,
        );
        writeFileSync(
            join(workdir, "lunora", "workflows.ts"),
            `import { defineWorkflow } from "@lunora/workflow";\nimport { privacy } from "./privacy";\n\nexport const privacyExport = defineWorkflow({ handler: privacy.exportHandler, name: "privacy-export" });\n`,
        );

        expect(generate()).toContain("export class PrivacyExportWorkflow");
    });

    it("rejects a config imported from a package, because codegen reads the literal statically", () => {
        expect.assertions(1);

        writePackage(`export declare const exportWorkflow: { name: string; handler: (ctx: { params: { userId: string } }) => Promise<void> };\n`);
        writeFileSync(
            join(workdir, "lunora", "workflows.ts"),
            `import { defineWorkflow } from "@lunora/workflow";\nimport { exportWorkflow } from "@fixture/privacy";\n\nexport const privacyExport = defineWorkflow(exportWorkflow);\n`,
        );

        expect(() => generate()).toThrow(/defineWorkflow's argument must be an object literal/u);
    });

    it("rejects a config passed as a property of an app object", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "privacy.ts"),
            `export const privacy = {\n  exportWorkflow: { name: "privacy-export", handler: async (ctx: { params: { userId: string } }) => ctx.params },\n};\n`,
        );
        writeFileSync(
            join(workdir, "lunora", "workflows.ts"),
            `import { defineWorkflow } from "@lunora/workflow";\nimport { privacy } from "./privacy";\n\nexport const privacyExport = defineWorkflow(privacy.exportWorkflow);\n`,
        );

        expect(() => generate()).toThrow(/defineWorkflow's argument must be an object literal/u);
    });
});
