import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { runCodegenPass } from "../src/codegen";
import { resolveOptions } from "../src/options";
import { createFixture } from "./fixture";

describe("lazy function codegen", () => {
    it.each([false, true])("keeps lazyFunctions=%s across regeneration", (lazyFunctions) => {
        expect.assertions(6);

        const projectRoot = createFixture();
        onTestFinished(() => {
            rmSync(projectRoot, { force: true, recursive: true });
        });
        const source = join(projectRoot, "lunora", "messages.ts");
        writeFileSync(source, 'import { query } from "@lunora/server";\nexport const list = query({ handler: async () => [] });\n', "utf8");
        const options = resolveOptions({ lazyFunctions, projectRoot });
        const logger = { error: vi.fn<(message: string) => void>(), info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };
        const functionsPath = join(projectRoot, "lunora", "_generated", "functions.ts");
        const shimPath = join(projectRoot, "lunora", "_generated", "fn", "lunora_messages_0.ts");

        runCodegenPass(options, logger);

        expect(readFileSync(functionsPath, "utf8").includes("export const LUNORA_FUNCTION_MANIFEST")).toBe(lazyFunctions);
        expect(existsSync(shimPath)).toBe(lazyFunctions);

        writeFileSync(source, 'import { query } from "@lunora/server";\nexport const latest = query({ handler: async () => [] });\n', "utf8");
        runCodegenPass(options, logger);
        const regenerated = readFileSync(functionsPath, "utf8");

        expect(regenerated.includes("export const LUNORA_FUNCTION_MANIFEST")).toBe(lazyFunctions);
        expect(existsSync(shimPath)).toBe(lazyFunctions);
        expect(regenerated).toContain("messages:latest");
        expect(regenerated).not.toContain("messages:list");
    });
});
