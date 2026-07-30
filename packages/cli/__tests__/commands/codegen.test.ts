import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCodegenCommand } from "../../src/commands/codegen/handler";
import type { Logger } from "../../src/util/logger";

/** Run `body` while capturing everything written to `process.stdout`. */
const captureStdout = (body: () => void): string => {
    let captured = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
        captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

        return true;
    });

    try {
        body();
    } finally {
        spy.mockRestore();
    }

    return captured;
};

/** Build a `lunora/crons.ts` with `count` distinct daily schedules (distinct hours → distinct expressions). */
const cronsFile = (count: number): string => {
    const lines = Array.from(
        { length: count },
        (_unused, index) => `crons.daily("job ${String(index)}", { hourUTC: ${String(index)}, minuteUTC: 0 }, internal.jobs.run${String(index)}, {});`,
    );

    return `import { cronJobs } from "@lunora/scheduler";\n\nimport { internal } from "./_generated/api.js";\n\nconst crons = cronJobs();\n\n${lines.join("\n")}\n\nexport default crons;\n`;
};

const here = dirname(fileURLToPath(import.meta.url));
// Reuse the same fixture that @lunora/codegen uses for its own tests.
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

describe("lunora codegen", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-codegen-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("deploy target", () => {
        it("emits the default surface with no target given", () => {
            expect.assertions(2);

            const before = runCodegenCommand({ cwd: workdir, logger: silentLogger() });
            const generated = readFileSync(join(workdir, "lunora", "_generated", "server.ts"), "utf8");

            expect(before.error).toBeUndefined();

            // Byte-identical, not merely present: the default path is what every
            // existing project already builds, so this asserts the target work
            // changed nothing for them rather than just that a file exists.
            runCodegenCommand({ cwd: workdir, logger: silentLogger(), target: "cloudflare" });

            expect(readFileSync(join(workdir, "lunora", "_generated", "server.ts"), "utf8")).toBe(generated);
        });

        it("refuses an unregistered --target instead of emitting an un-gated surface", () => {
            expect.assertions(2);

            const result = runCodegenCommand({ cwd: workdir, logger: silentLogger(), target: "aws" });

            // Codegen resolves no driver of its own, so without the explicit
            // validation this would emit the full Cloudflare surface for a
            // target that does not exist, warn, and exit 0 — the silent
            // fallback the driver registry exists to prevent.
            expect(result.error).toMatch(/unknown deploy target "aws"/);

            // Nothing was written: the target is rejected before codegen runs,
            // so a rejected run cannot leave a half-emitted surface behind.
            expect(existsSync(join(workdir, "lunora", "_generated", "server.ts"))).toBe(false);
        });

        it("refuses an unregistered target from lunora.json", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "lunora.json"), JSON.stringify({ target: "clouflare" }), "utf8");

            // A typo in the committed config must fail the same way as a typo on
            // the command line — the config path is where it would otherwise go
            // unnoticed for longest.
            expect(runCodegenCommand({ cwd: workdir, logger: silentLogger() }).error).toMatch(/unknown deploy target "clouflare"/);
        });

        it("lets --target override lunora.json", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "lunora.json"), JSON.stringify({ target: "aws" }), "utf8");

            expect(runCodegenCommand({ cwd: workdir, logger: silentLogger(), target: "cloudflare" }).error).toBeUndefined();
        });
    });

    describe("lunora codegen", () => {
        it("writes the three generated files", () => {
            expect.assertions(3);

            runCodegenCommand({ cwd: workdir, logger: silentLogger() });

            const generated = join(workdir, "lunora", "_generated");

            expect(existsSync(join(generated, "dataModel.ts"))).toBe(true);
            expect(existsSync(join(generated, "api.ts"))).toBe(true);
            expect(existsSync(join(generated, "server.ts"))).toBe(true);
        });

        it("defaults to openapi: writes openapi.json, not openrpc.json", () => {
            expect.assertions(2);

            runCodegenCommand({ cwd: workdir, logger: silentLogger() });

            const generated = join(workdir, "lunora", "_generated");

            expect(existsSync(join(generated, "openapi.json"))).toBe(true);
            expect(existsSync(join(generated, "openrpc.json"))).toBe(false);
        });

        it('apiSpec:"both" writes both spec files', () => {
            expect.assertions(2);

            runCodegenCommand({ apiSpec: "both", cwd: workdir, logger: silentLogger() });

            const generated = join(workdir, "lunora", "_generated");

            expect(existsSync(join(generated, "openapi.json"))).toBe(true);
            expect(existsSync(join(generated, "openrpc.json"))).toBe(true);
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

            writeFileSync(join(workdir, "lunora", "crons.ts"), cronsFile(4), "utf8");

            const warnings: string[] = [];

            runCodegenCommand({ cwd: workdir, logger: { ...silentLogger(), warn: (message) => warnings.push(message) } });

            // Filtered to the cron warning specifically — the fixture also emits a
            // schema advisory (see the advisory test below), so a raw count would
            // couple this cron assertion to unrelated advisor output.
            const cronWarnings = warnings.filter((message) => message.includes("Cron Triggers per Worker"));

            expect(cronWarnings).toHaveLength(1);
            expect(cronWarnings[0]).toContain("Cron Triggers per Worker");
        });

        it("does not warn at the cron-trigger limit", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "lunora", "crons.ts"), cronsFile(3), "utf8");

            const warnings: string[] = [];

            runCodegenCommand({ cwd: workdir, logger: { ...silentLogger(), warn: (message) => warnings.push(message) } });

            expect(warnings.filter((message) => message.includes("Cron Triggers per Worker"))).toHaveLength(0);
        });

        it("surfaces static schema advisories (unindexed foreign key)", () => {
            expect.assertions(3);

            const warnings: string[] = [];

            // The `simple` fixture's `attachments.ownerId` is a `one`-relation FK
            // with no covering index, so the static advisor flags it.
            runCodegenCommand({ cwd: workdir, logger: { ...silentLogger(), warn: (message) => warnings.push(message) } });

            const advisoryWarnings = warnings.filter((message) => message.includes("unindexed_foreign_key"));

            expect(advisoryWarnings).toHaveLength(1);
            expect(advisoryWarnings[0]).toContain("attachments");
            expect(advisoryWarnings[0]).toContain("advisory");
        });

        describe("--format json", () => {
            it("emits a single parseable JSON document with the structured result", () => {
                expect.assertions(4);

                const stdout = captureStdout(() => {
                    runCodegenCommand({ cwd: workdir, format: "json", logger: silentLogger() });
                });

                const parsed = JSON.parse(stdout) as { advisories: unknown[]; cronTriggers: unknown[]; outputDirectory: string };

                expect(parsed).toHaveProperty("outputDirectory");
                expect(parsed.outputDirectory).toContain("_generated");
                expect(Array.isArray(parsed.advisories)).toBe(true);
                expect(Array.isArray(parsed.cronTriggers)).toBe(true);
            });

            it("rejects an unknown --format the same way logs does", () => {
                expect.assertions(3);

                const errors: string[] = [];

                const stdout = captureStdout(() => {
                    const result = runCodegenCommand({ cwd: workdir, format: "yaml", logger: { ...silentLogger(), error: (message) => errors.push(message) } });

                    expect(result.error).toBeDefined();
                });

                expect(stdout).toBe("");
                expect(errors.some((line) => line.includes('unknown --format "yaml" — expected pretty | json'))).toBe(true);
            });
        });
    });
});
