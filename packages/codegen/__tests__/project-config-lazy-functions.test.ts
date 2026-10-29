import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readProjectConfigLiterals, readProjectLazyFunctions } from "../src/project-config-file";
import { runCodegen } from "../src/run-codegen";

describe("codegen.lazyFunctions in lunora.config", () => {
    let projectRoot: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-lazy-config-"));
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
        vi.restoreAllMocks();
    });

    const writeConfig = (body: string): void => {
        writeFileSync(join(projectRoot, "lunora.config.ts"), `export default ${body};\n`, "utf8");
    };

    it.each([
        ["{ codegen: { lazyFunctions: true } }", { lazyFunctions: true }],
        ["{ codegen: { lazyFunctions: false } }", { lazyFunctions: false }],
        ["{ codegen: { lazyFunctions: true as boolean } }", { lazyFunctions: true }],
        ["{ codegen: { exclude: ['seed/**'], lazyFunctions: true } }", { exclude: ["seed/**"], lazyFunctions: true }],
        ["{ codegen: { exclude: 'seed/**', lazyFunctions: true } }", { lazyFunctions: true, unreadable: true }],
        ["{ codegen: { exclude: ['seed/**'], lazyFunctions: process.env.LAZY === '1' } }", { exclude: ["seed/**"], lazyFunctionsUnreadable: true }],
        ["{ codegen: { ...shared, lazyFunctions: true } }", { lazyFunctionsUnreadable: true, unreadable: true }],
        ["{ get codegen() { return { lazyFunctions: true }; } }", { lazyFunctionsUnreadable: true, unreadable: true }],
    ])("reads %s", (body, expected) => {
        expect.assertions(1);

        writeConfig(body);

        expect(readProjectConfigLiterals(projectRoot).codegen).toStrictEqual(expected);
    });

    it("treats an unreadable value as off and says so", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeConfig("{ codegen: { lazyFunctions: process.env.LAZY === '1' } }");

        expect(readProjectLazyFunctions(projectRoot)).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("`codegen.lazyFunctions`"));
    });

    it("emits the lazy registry from the config when the caller passes no flag, and a false flag does not veto it", () => {
        expect.assertions(3);

        cpSync(join(import.meta.dirname, "fixtures", "simple", "lunora"), join(projectRoot, "lunora"), { recursive: true });
        writeConfig("{ codegen: { lazyFunctions: true } }");

        const functionsPath = join(projectRoot, "lunora", "_generated", "functions.ts");

        runCodegen({ lint: false, projectRoot, wranglerQueueProducers: [] });

        expect(readFileSync(functionsPath, "utf8")).toContain("export const LUNORA_FUNCTION_MANIFEST");

        runCodegen({ lazyFunctions: false, lint: false, projectRoot, wranglerQueueProducers: [] });

        expect(readFileSync(functionsPath, "utf8")).toContain("export const LUNORA_FUNCTION_MANIFEST");

        writeConfig("{ codegen: { lazyFunctions: false } }");
        runCodegen({ lint: false, projectRoot, wranglerQueueProducers: [] });

        expect(readFileSync(functionsPath, "utf8")).not.toContain("export const LUNORA_FUNCTION_MANIFEST");
    });
});
