import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    it("does not warn about a codegen value that never names lazyFunctions", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeConfig("{ codegen: base.codegen }");

        expect(readProjectLazyFunctions(join(projectRoot, "lunora"))).toBe(false);
        expect(warn).not.toHaveBeenCalled();
    });

    it("says an unreadable lazyFunctions once per config version, not on every run", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeConfig("{ codegen: { lazyFunctions: process.env.LAZY === '1' } }");
        readProjectLazyFunctions(join(projectRoot, "lunora"));
        readProjectLazyFunctions(join(projectRoot, "lunora"));

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("not a boolean literal");
    });

    it("treats an unreadable value as off and says so", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeConfig("{ codegen: { lazyFunctions: process.env.LAZY === '1' } }");

        expect(readProjectLazyFunctions(join(projectRoot, "lunora"))).toBe(false);
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
    it("reads a lazyFunctions value passed through a parenthesized const default export", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeFileSync(join(projectRoot, "lunora.config.ts"), "const config = ({ codegen: { lazyFunctions: true } });\nexport default config;\n", "utf8");

        expect(readProjectLazyFunctions(join(projectRoot, "lunora"))).toBe(true);
        expect(warn).not.toHaveBeenCalled();
    });

    it("reads a codegen value that names a const in the same file", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeFileSync(
            join(projectRoot, "lunora.config.ts"),
            "const sharedCodegen = { lazyFunctions: true };\nexport default { codegen: sharedCodegen };\n",
            "utf8",
        );

        expect(readProjectLazyFunctions(join(projectRoot, "lunora"))).toBe(true);
        expect(warn).not.toHaveBeenCalled();
    });

    it("says an imported shorthand codegen, since the object it names may set lazyFunctions", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeFileSync(join(projectRoot, "lunora.config.ts"), 'import codegen from "./shared";\nexport default { codegen };\n', "utf8");

        expect(readProjectLazyFunctions(join(projectRoot, "lunora"))).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a boolean literal"));
    });

    it("says a codegen name bound to a call it cannot read, since the call may set lazyFunctions", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeFileSync(join(projectRoot, "lunora.config.ts"), "const sharedCodegen = makeCodegen();\nexport default { codegen: sharedCodegen };\n", "utf8");

        expect(readProjectLazyFunctions(join(projectRoot, "lunora"))).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a boolean literal"));
    });

    it("reads a codegen name that is parenthesized or cast", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeFileSync(
            join(projectRoot, "lunora.config.ts"),
            "const sharedCodegen = { lazyFunctions: true };\nexport default { codegen: (sharedCodegen as Record<string, unknown>) };\n",
            "utf8",
        );

        expect(readProjectLazyFunctions(join(projectRoot, "lunora"))).toBe(true);
        expect(warn).not.toHaveBeenCalled();
    });

    it("does not trust a named const that is written after its declaration", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeFileSync(
            join(projectRoot, "lunora.config.ts"),
            "const sharedCodegen = { lazyFunctions: false };\nsharedCodegen.lazyFunctions = true;\nexport default { codegen: sharedCodegen };\n",
            "utf8",
        );

        expect(readProjectLazyFunctions(join(projectRoot, "lunora"))).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a boolean literal"));
    });

    it("does not follow a let binding, whose value may change before the config runs", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeFileSync(
            join(projectRoot, "lunora.config.ts"),
            "let sharedCodegen = { lazyFunctions: true };\nexport default { codegen: sharedCodegen };\n",
            "utf8",
        );

        expect(readProjectLazyFunctions(join(projectRoot, "lunora"))).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a boolean literal"));
    });

    it("says a codegen name it cannot resolve, since an imported object may set lazyFunctions", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        writeFileSync(join(projectRoot, "lunora.config.ts"), 'import shared from "./shared";\nexport default { codegen: shared };\n', "utf8");

        expect(readProjectLazyFunctions(join(projectRoot, "lunora"))).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a boolean literal"));
    });

    it("reads the nearest config above a nested Lunora folder, as codegen.exclude does", () => {
        expect.assertions(1);

        mkdirSync(join(projectRoot, "src"));
        writeFileSync(join(projectRoot, "src", "lunora.config.ts"), "export default { codegen: { lazyFunctions: true } };\n", "utf8");

        expect(readProjectLazyFunctions(join(projectRoot, "src", "lunora"))).toBe(true);
    });

    it("still says an unreadable value when the caller already passes the flag", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        cpSync(join(import.meta.dirname, "fixtures", "simple", "lunora"), join(projectRoot, "lunora"), { recursive: true });
        writeConfig("{ codegen: { lazyFunctions: process.env.LAZY === '1' } }");

        runCodegen({ lazyFunctions: true, lint: false, projectRoot, wranglerQueueProducers: [] });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a boolean literal"));
        expect(readFileSync(join(projectRoot, "lunora", "_generated", "functions.ts"), "utf8")).toContain("export const LUNORA_FUNCTION_MANIFEST");
    });
});
