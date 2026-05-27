import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runCodegenCommand } from "../../src/commands/codegen.js";
import type { Logger } from "../../src/util/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
// Reuse the same fixture that @cirrus/codegen uses for its own tests.
const fixtureRoot = join(here, "..", "..", "..", "cirrus-codegen", "__tests__", "fixtures", "simple");

const silentLogger = (): Logger => ({
    error: () => {},
    info: () => {},
    success: () => {},
    warn: () => {},
});

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-codegen-"));
    cpSync(join(fixtureRoot, "cirrus"), join(workdir, "cirrus"), { recursive: true });
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("cirrus codegen", () => {
    test("writes the three generated files", () => {
        runCodegenCommand({ cwd: workdir, logger: silentLogger() });

        const generated = join(workdir, "cirrus", "_generated");

        expect(existsSync(join(generated, "dataModel.ts"))).toBe(true);
        expect(existsSync(join(generated, "api.ts"))).toBe(true);
        expect(existsSync(join(generated, "server.ts"))).toBe(true);
    });

    test("logs success once codegen completes", () => {
        const success: string[] = [];

        runCodegenCommand({ cwd: workdir, logger: { ...silentLogger(), success: (msg) => success.push(msg) } });

        expect(success.length).toBe(1);
        expect(success[0]).toContain("_generated");
    });
});
