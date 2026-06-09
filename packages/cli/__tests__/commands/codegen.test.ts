import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegenCommand } from "../../src/commands/codegen";
import type { Logger } from "../../src/util/logger";

/** Build a `cirrus/crons.ts` with `count` distinct daily schedules (distinct hours → distinct expressions). */
const cronsFile = (count: number): string => {
    const lines = Array.from(
        { length: count },
        (_unused, index) => `crons.daily("job ${String(index)}", { hourUTC: ${String(index)}, minuteUTC: 0 }, internal.jobs.run${String(index)}, {});`,
    );

    return `import { cronJobs } from "@cirrus/scheduler";\n\nimport { internal } from "./_generated/api.js";\n\nconst crons = cronJobs();\n\n${lines.join("\n")}\n\nexport default crons;\n`;
};

const here = dirname(fileURLToPath(import.meta.url));
// Reuse the same fixture that @cirrus/codegen uses for its own tests.
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

let workdir: string;

describe("cirrus codegen", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-codegen-"));
        cpSync(join(fixtureRoot, "cirrus"), join(workdir, "cirrus"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("cirrus codegen", () => {
        it("writes the three generated files", () => {
            expect.assertions(3);

            runCodegenCommand({ cwd: workdir, logger: silentLogger() });

            const generated = join(workdir, "cirrus", "_generated");

            expect(existsSync(join(generated, "dataModel.ts"))).toBe(true);
            expect(existsSync(join(generated, "api.ts"))).toBe(true);
            expect(existsSync(join(generated, "server.ts"))).toBe(true);
        });

        it("logs success once codegen completes", () => {
            expect.assertions(2);

            const success: string[] = [];

            runCodegenCommand({ cwd: workdir, logger: { ...silentLogger(), success: (message) => success.push(message) } });

            expect(success).toHaveLength(1);
            expect(success[0]).toContain("_generated");
        });

        it("warns when distinct cron expressions exceed the per-Worker limit", () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "cirrus", "crons.ts"), cronsFile(4), "utf8");

            const warnings: string[] = [];

            runCodegenCommand({ cwd: workdir, logger: { ...silentLogger(), warn: (message) => warnings.push(message) } });

            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("Cron Triggers per Worker");
        });

        it("does not warn at the cron-trigger limit", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "cirrus", "crons.ts"), cronsFile(3), "utf8");

            const warnings: string[] = [];

            runCodegenCommand({ cwd: workdir, logger: { ...silentLogger(), warn: (message) => warnings.push(message) } });

            expect(warnings).toHaveLength(0);
        });
    });
});
