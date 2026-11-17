import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findCodegenConfigFile, projectConfigCandidatePaths } from "../src/project-config-path";

describe("codegen config discovery", () => {
    let root: string;
    let schemaDirectory: string;

    beforeEach(() => {
        // A project root under a parent that holds a config of its own, which must not count.
        const parent = mkdtempSync(join(tmpdir(), "lunora-config-path-"));

        root = join(parent, "app");
        schemaDirectory = join(root, "web", "lunora");

        mkdirSync(schemaDirectory, { recursive: true });
        writeFileSync(join(parent, "lunora.config.ts"), "export default {};\n", "utf8");
        writeFileSync(join(root, "package.json"), "{}\n", "utf8");
    });

    afterEach(() => {
        rmSync(join(root, ".."), { force: true, recursive: true });
    });

    it("reads the nearest config above the schema directory, and never one inside it", () => {
        expect.assertions(3);

        writeFileSync(join(root, "lunora.config.ts"), "export default {};\n", "utf8");
        writeFileSync(join(schemaDirectory, "lunora.config.ts"), "export default {};\n", "utf8");

        // The root's config is the only one above the schema directory so far.
        expect(findCodegenConfigFile(schemaDirectory)).toBe(join(root, "lunora.config.ts"));

        writeFileSync(join(root, "web", "lunora.config.ts"), "export default {};\n", "utf8");

        expect(findCodegenConfigFile(schemaDirectory)).toBe(join(root, "web", "lunora.config.ts"));
        expect(findCodegenConfigFile(schemaDirectory)).not.toBe(join(schemaDirectory, "lunora.config.ts"));
    });

    it("falls back to the project root's config when no nearer one exists", () => {
        expect.assertions(1);

        writeFileSync(join(root, "lunora.config.ts"), "export default {};\n", "utf8");

        expect(findCodegenConfigFile(schemaDirectory)).toBe(join(root, "lunora.config.ts"));
    });

    it("stops at the project root, so a config above it is not read", () => {
        expect.assertions(1);

        expect(findCodegenConfigFile(schemaDirectory)).toBeUndefined();
    });

    it("lists every candidate, present or not, so a watcher catches a config created later", () => {
        expect.assertions(1);

        expect(projectConfigCandidatePaths(schemaDirectory)).toContain(join(root, "web", "lunora.config.mjs"));
    });
});
