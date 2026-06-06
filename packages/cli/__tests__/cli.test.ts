import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOLEAN_OPTIONS, COMMANDS, runCli } from "../src/cli.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const templatesRoot = resolve(testDirectory, "..", "..", "..", "templates");

describe("cirrus CLI entry", () => {
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

    it("`cirrus --help` prints help and exits 0", async () => {
        expect.hasAssertions();

        const code = await runCli({ argv: ["--help"] });

        expect(code).toBe(0);
        expect(stdout).toContain("cirrus —");

        for (const command of COMMANDS) {
            expect(stdout).toContain(command);
        }
    });

    it("no args prints help", async () => {
        expect.assertions(2);

        const code = await runCli({ argv: [] });

        expect(code).toBe(0);
        expect(stdout).toContain("Usage: cirrus");
    });

    it("`--version` prints a version", async () => {
        expect.assertions(2);

        const code = await runCli({ argv: ["--version"] });

        expect(code).toBe(0);
        expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
    });

    it("unknown command exits non-zero", async () => {
        expect.assertions(2);

        const code = await runCli({ argv: ["zzz-not-real"] });

        expect(code).toBe(1);
        expect(stderr).toContain("unknown command");
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

        it("the former top-level `add` command is gone", async () => {
            expect.assertions(1);

            const code = await runCli({ argv: ["add", "presence"] });

            expect(code).toBe(1);
        });
    });

    describe("argv reorder (option-after-positional)", () => {
        // The published cerebro@2.1.5 swallows space-separated options that
        // appear after a positional argument into the positional array; we
        // sidestep that by reordering argv in runCli. These tests pin the
        // behaviour from the public CLI surface.
        let workdir: string;

        beforeEach(() => {
            workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-argv-"));
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

        it("default template (no `-t` flag) is vite", async () => {
            expect.assertions(2);

            const code = await runCli({
                argv: ["init", "argv_default", "--from", templatesRoot],
                cwd: workdir,
            });

            expect(code).toBe(0);

            const target = join(workdir, "argv_default");

            expect(existsSync(join(target, "vite.config.ts"))).toBe(true);
        });
    });
});

describe("bOOLEAN_OPTIONS stays in sync with command definitions", () => {
    it("includes every `type: Boolean` option declared across all commands", () => {
        expect.assertions(2);

        // reorderArgvOptionsFirst relies on this hand-maintained set to know
        // which flags do NOT consume the next token. If a future command adds
        // a Boolean flag but forgets to register it here, that flag would
        // greedily swallow the following positional with no error. This scans
        // the source for every `{ ..., name: "x", ..., type: Boolean }` option
        // and asserts membership, so the set can't silently desync.
        const source = readFileSync(resolve(testDirectory, "..", "src", "cli.ts"), "utf8");
        // Match option objects whose `type` is Boolean, capturing the `name`.
        const optionPattern = /\{[^{}]*name:\s*"([a-z][\w-]*)"[^{}]*type:\s*Boolean[^{}]*\}/gu;
        const booleanNames = new Set<string>();

        for (const match of source.matchAll(optionPattern)) {
            if (match[1] !== undefined) {
                booleanNames.add(match[1]);
            }
        }

        // Sanity: the scan must find the known Boolean flags, otherwise the
        // regex broke and the assertion below would pass vacuously.
        expect(booleanNames.size).toBeGreaterThan(0);

        const missing = [...booleanNames].filter((name) => !BOOLEAN_OPTIONS.has(name));

        expect(missing).toStrictEqual([]);
    });
});
