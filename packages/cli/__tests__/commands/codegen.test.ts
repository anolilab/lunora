import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { inferLunoraBindings } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CodegenCommandData } from "../../src/commands/codegen/handler";
import { execute, runCodegenCommand } from "../../src/commands/codegen/handler";
import type { CodegenOptions } from "../../src/commands/codegen/index";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";
import { runExecute } from "../helpers/execute";

// eslint-disable-next-line vitest/prefer-import-in-mock -- the import form type-checks the mock against the module's full type, which this partial re-export doesn't satisfy
vi.mock("@lunora/config", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@lunora/config")>();

    return { ...actual, inferLunoraBindings: vi.fn<typeof actual.inferLunoraBindings>(actual.inferLunoraBindings) };
});

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
            expect.assertions(3);

            const result = runCodegenCommand({ cwd: workdir, logger: silentLogger(), target: "aws" });

            // Codegen resolves no driver of its own, so without the explicit
            // validation this would emit the full Cloudflare surface for a
            // target that does not exist, warn, and exit 0 — the silent
            // fallback the driver registry exists to prevent.
            expect(result.error).toMatch(/unknown deploy target "aws"/);
            // Exit 2, like a bad `--format`: the flag names a driver that does
            // not exist, so it is the invocation that is wrong, not codegen.
            expect(result.code).toBe(EXIT_CODE.USAGE);

            // Nothing was written: the target is rejected before codegen runs,
            // so a rejected run cannot leave a half-emitted surface behind.
            expect(existsSync(join(workdir, "lunora", "_generated", "server.ts"))).toBe(false);
        });

        it("refuses an unregistered target from lunora.config.ts", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "lunora.config.ts"), `export default { target: "clouflare" };\n`, "utf8");

            // A typo in the committed config must fail the same way as a typo on
            // the command line — the config path is where it would otherwise go
            // unnoticed for longest.
            expect(runCodegenCommand({ cwd: workdir, logger: silentLogger() }).error).toMatch(/unknown deploy target "clouflare"/);
        });

        it("lets --target override lunora.config.ts", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "lunora.config.ts"), `export default { target: "aws" };\n`, "utf8");

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
            // Through `execute`, because the envelope is written by `defineHandler`:
            // `runCodegenCommand` is the library entry point and writes nothing.
            it("emits a single parseable JSON envelope with the structured result", async () => {
                expect.assertions(5);

                const { code, document } = await runExecute<CodegenOptions, CodegenCommandData>(execute, {
                    commandName: "codegen",
                    cwd: workdir,
                    options: { format: "json" },
                });

                expect(code).toBe(0);
                expect(document?.code).toBe(0);
                expect(document?.data?.outputDirectory).toContain("_generated");
                expect(Array.isArray(document?.data?.advisories)).toBe(true);
                expect(Array.isArray(document?.data?.cronTriggers)).toBe(true);
            });
        });
    });

    /**
     * A declared workflow whose generated class the worker entry never re-exports
     * is invisible to everything codegen can check: `tsc` is clean, codegen is
     * clean, the tests pass, and wrangler only rejects the `class_name` at deploy.
     * The dev overlay and `build`/`deploy` warn, but a project driving its own dev
     * server and deploying through its own IaC runs neither — `lunora codegen` was
     * the one command it does run that stayed silent.
     */
    describe("unexported generated classes", () => {
        const seedWorkflow = (entry: string): void => {
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                JSON.stringify({
                    compatibility_date: "2026-04-07",
                    durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                    main: "src/server.ts",
                    name: "demo",
                }),
                "utf8",
            );
            mkdirSync(join(workdir, "src"), { recursive: true });
            writeFileSync(join(workdir, "src", "server.ts"), entry, "utf8");
            writeFileSync(
                join(workdir, "lunora", "workflows.ts"),
                'import { defineWorkflow } from "@lunora/workflow";\nexport const orderPipeline = defineWorkflow({ run: async () => undefined });\n',
                "utf8",
            );
        };

        /** Drive the real command handler — the warning lives in the `execute` wrapper, not in `runCodegenCommand`. */
        const captureExecuteStderr = async (options: Record<string, string> = {}): Promise<string> => {
            let captured = "";
            const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
                captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

                return true;
            });

            try {
                await execute({
                    argument: [],
                    options: { format: "json", ...options },
                    process: { cwd: workdir, exit: () => {} },
                } as unknown as Parameters<typeof execute>[0]);
            } finally {
                spy.mockRestore();
            }

            return captured;
        };

        it("warns when a declared workflow is not exported by the worker entry", async () => {
            expect.assertions(1);

            seedWorkflow('import { createShardDO } from "../lunora/_generated/shard.js";\nexport const ShardDO = createShardDO();\n');

            await expect(captureExecuteStderr()).resolves.toMatch(/workflow "orderPipeline" is declared but .* is not exported by the worker entry/u);
        });

        // `runCodegenCommand` returns before generation for an invalid `--format`
        // or an unresolved `--target`. Scanning anyway stacks export-gap warnings
        // on top of the real error, about a codegen that never ran — and the
        // classes it would name are whatever a previous run happened to leave on
        // disk. The seed here WOULD warn on a successful run, so these fail if the
        // scan is not gated.
        it.each([
            ["an invalid --format", { format: "nope" }],
            ["an unresolved --target", { target: "not-a-registered-target" }],
        ])("does not scan for export gaps after %s", async (_label, overrides) => {
            expect.assertions(2);

            seedWorkflow('import { createShardDO } from "../lunora/_generated/shard.js";\nexport const ShardDO = createShardDO();\n');

            const output = await captureExecuteStderr(overrides);

            expect(output).not.toMatch(/is not exported by the worker entry/u);
            // …and the actual validation error is still reported.
            expect(output).not.toBe("");
        });

        it("stays quiet when the worker entry re-exports the generated module", async () => {
            expect.assertions(1);

            seedWorkflow(
                'import { createShardDO } from "../lunora/_generated/shard.js";\nexport const ShardDO = createShardDO();\nexport * from "../lunora/_generated/workflows.js";\n',
            );

            await expect(captureExecuteStderr()).resolves.not.toMatch(/is not exported by the worker entry/u);
        });

        it("teaches the project's linter to skip the generated output", async () => {
            expect.assertions(2);

            // `init` offers this and `add` re-applies it, which covers a project
            // Lunora scaffolded. A project that adopted Lunora INTO an existing
            // codebase never runs either, so nothing told its linter about
            // `_generated/` and the first lint buried real findings under
            // thousands of generated-file errors. Every project runs codegen.
            seedWorkflow('import { createShardDO } from "../lunora/_generated/shard.js";\nexport const ShardDO = createShardDO();\n');
            // A linter already configured, and nothing that ever ran `lunora init`
            // to tell it about `_generated/` — what an existing codebase adopting
            // Lunora looks like. Detected from the config file rather than a
            // manifest, so this fixture does not also have to satisfy codegen's
            // required-add-on check.
            writeFileSync(join(workdir, ".prettierrc"), JSON.stringify({ semi: true }), "utf8");
            writeFileSync(join(workdir, ".prettierignore"), "dist\n", "utf8");

            await captureExecuteStderr();

            const ignored = readFileSync(join(workdir, ".prettierignore"), "utf8");

            expect(ignored).toContain("_generated");
            // Idempotent: the pre-existing entry is preserved, not replaced.
            expect(ignored).toContain("dist");
        });

        it("says so when the check itself could not run, instead of reading as clean", async () => {
            expect.assertions(2);

            // Inference is best-effort here — the commands that GATE on export
            // gaps own its failures. But returning silently made a skipped check
            // indistinguishable from a passing one, so a project whose entry
            // could not be resolved read `lunora codegen` as proof its workflows
            // were wired and found out at deploy.
            seedWorkflow('import { createShardDO } from "../lunora/_generated/shard.js";\nexport const ShardDO = createShardDO();\n');

            vi.mocked(inferLunoraBindings).mockRejectedValueOnce(new Error("cannot resolve the worker entry"));

            const output = await captureExecuteStderr();

            expect(output).toMatch(/could not check whether declared containers\/workflows\/agents are re-exported/u);
            expect(output).toContain("cannot resolve the worker entry");
        });
    });
});
