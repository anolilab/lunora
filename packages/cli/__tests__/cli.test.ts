import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COMMANDS, REGISTERED_COMMAND_NAMES, runCli, VERSION } from "../src/cli";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const templatesRoot = resolve(testDirectory, "..", "..", "..", "templates");

describe("lunora CLI entry", () => {
    let stdout: string;
    let stderr: string;
    let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
    let writeStderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        stdout = "";
        stderr = "";

        writeStdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
            stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

            return true;
        });

        writeStderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

            return true;
        });
    });

    afterEach(() => {
        writeStdoutSpy.mockRestore();
        writeStderrSpy.mockRestore();
    });

    // cerebro renders help/version/usage through its injected logger (not raw
    // process.stdout), so capture it via the `logger` option and fold in the
    // stdout spy for anything that bypasses the logger.
    const captureLogger = (): { lines: string[]; logger: Console } => {
        const lines: string[] = [];
        const push = (...arguments_: unknown[]): void => {
            lines.push(arguments_.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
        };

        return { lines, logger: { debug: push, error: push, info: push, log: push, raw: push, trace: push, warn: push } as unknown as Console };
    };

    it("`lunora --help` lists every command and exits 0", async () => {
        expect.hasAssertions();

        const { lines, logger } = captureLogger();
        const code = await runCli({ argv: ["--help"], logger });

        expect(code).toBe(0);

        const output = `${lines.join("\n")}\n${stdout}`;

        for (const command of COMMANDS) {
            expect(output).toContain(command);
        }
    });

    it.each(REGISTERED_COMMAND_NAMES)("`lunora %s --help` renders and exits 0", async (command) => {
        expect.assertions(2);

        // `import --help` and `run --help` both died with "Found extraneous } in
        // template literal": cerebro renders help text through chalk's
        // tagged-template parser, which reads `{...}` as style syntax, so a
        // literal brace in ANY description hard-errors that command's help.
        // The failure is invisible until someone asks for help on that specific
        // command, which is exactly when they can least afford it — so every
        // command's help is rendered here rather than spot-checking the two.
        const { lines, logger } = captureLogger();
        const code = await runCli({ argv: [command, "--help"], logger });

        expect(code).toBe(0);
        expect(`${lines.join("\n")}\n${stdout}${stderr}`).not.toContain("extraneous");
    });

    it("no args prints usage and exits 0", async () => {
        expect.assertions(2);

        const { lines, logger } = captureLogger();
        const code = await runCli({ argv: [], logger });

        expect(code).toBe(0);
        expect(`${lines.join("\n")}\n${stdout}`).toMatch(/Usage|lunora <command>/u);
    });

    it("`--version` prints a version and exits 0", async () => {
        expect.assertions(2);

        const { lines, logger } = captureLogger();
        const code = await runCli({ argv: ["--version"], logger });

        expect(code).toBe(0);
        expect(`${lines.join("")}${stdout}`).toContain(VERSION);
    });

    it("unknown command exits non-zero with a friendly message", async () => {
        expect.assertions(2);

        const code = await runCli({ argv: ["zzz-not-real"] });

        expect(code).toBe(1);
        // runCli upgrades cerebro's bare "not found" into a friendly message.
        expect(stderr).toContain("Unknown command");
    });

    it("a near-miss command suggests the closest match", async () => {
        expect.assertions(2);

        const code = await runCli({ argv: ["deployy"] });

        expect(code).toBe(1);
        expect(stderr).toContain('Did you mean "deploy"?');
    });

    describe("registry subcommands", () => {
        const registryRoot = resolve(testDirectory, "..", "..", "..", "registry");

        it("`registry list --from <root>` exits 0", async () => {
            expect.assertions(1);

            const code = await runCli({ argv: ["registry", "list", "--from", registryRoot] });

            expect(code).toBe(0);
        });

        it("`registry add <name> --dry-run` plans without writing and exits 0", async () => {
            expect.assertions(1);

            const code = await runCli({ argv: ["registry", "add", "presence", "--dry-run", "--from", registryRoot] });

            expect(code).toBe(0);
        });

        it("`registry build --check` confirms the committed catalog is current", async () => {
            expect.assertions(1);

            const code = await runCli({ argv: ["registry", "build", "--check", "--from", registryRoot] });

            expect(code).toBe(0);
        });

        it("an unknown registry subcommand exits non-zero", async () => {
            expect.assertions(2);

            const code = await runCli({ argv: ["registry", "frobnicate"] });

            expect(code).toBe(1);
            expect(stderr).toContain("unknown subcommand");
        });

        it("the top-level `add` is a feature command — `add presence` (a registry item, not a feature) is rejected", async () => {
            expect.assertions(1);

            // `lunora add` adds FEATURES (auth/email); a component like
            // `presence` is still added via `registry add`.
            const code = await runCli({ argv: ["add", "presence"] });

            expect(code).toBe(1);
        });
    });

    describe("option-after-positional parsing", () => {
        // cerebro 3 parses space-separated options that appear after a positional
        // argument correctly (the 2.1.5 quirk that swallowed them into the
        // positional array is fixed, so the CLI no longer reorders argv). These
        // tests pin that behaviour from the public CLI surface.
        let workdir: string;

        beforeEach(() => {
            workdir = mkdtempSync(join(tmpdir(), "lunora-cli-argv-"));
        });

        afterEach(() => {
            rmSync(workdir, { force: true, recursive: true });
        });

        it("`init <name> -t standalone` selects the standalone template", async () => {
            expect.assertions(3);

            const code = await runCli({
                argv: ["init", "argv_app", "-t", "standalone", "--from", templatesRoot],
                cwd: workdir,
            });

            expect(code).toBe(0);

            const target = join(workdir, "argv_app");

            // Standalone template has no vite.config.ts.
            expect(existsSync(join(target, "wrangler.jsonc"))).toBe(true);
            expect(existsSync(join(target, "vite.config.ts"))).toBe(false);
        });

        it("`init <name> --template standalone` (long-form) selects the standalone template", async () => {
            expect.assertions(2);

            const code = await runCli({
                argv: ["init", "argv_long", "--template", "standalone", "--from", templatesRoot],
                cwd: workdir,
            });

            expect(code).toBe(0);

            const target = join(workdir, "argv_long");

            expect(existsSync(join(target, "vite.config.ts"))).toBe(false);
        });

        it("`init <name> --template=standalone` (equals form) selects the standalone template", async () => {
            expect.assertions(2);

            const code = await runCli({
                argv: ["init", "argv_equals", "--template=standalone", "--from", templatesRoot],
                cwd: workdir,
            });

            expect(code).toBe(0);

            const target = join(workdir, "argv_equals");

            expect(existsSync(join(target, "vite.config.ts"))).toBe(false);
        });

        it("default (no `-t`, no `--vite`) with `--yes` scaffolds the React overlay", async () => {
            expect.assertions(2);

            // No `-t`/`--vite` → the React create-vite overlay is the default;
            // `--yes` opts into it rather than erroring. (Fetches create-vite, so
            // this one exercises the network path, unlike the `--from` tests.)
            const code = await runCli({
                argv: ["init", "argv_default", "--from", templatesRoot, "--yes"],
                cwd: workdir,
            });

            expect(code).toBe(0);

            const target = join(workdir, "argv_default");

            expect(existsSync(join(target, "vite.config.ts"))).toBe(true);
        });

        it("non-interactive init without `-t` or `--yes` errors instead of guessing a template", async () => {
            expect.assertions(2);

            const code = await runCli({
                argv: ["init", "argv_no_template", "--from", templatesRoot],
                cwd: workdir,
            });

            expect(code).toBe(1);
            expect(existsSync(join(workdir, "argv_no_template"))).toBe(false);
        });
    });
});
