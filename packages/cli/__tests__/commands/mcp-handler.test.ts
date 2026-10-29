import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli";
import { EXIT_CODE } from "../../src/util/exit-code";

let workdir: string;

/**
 * Drive the real CLI and report the exit code plus everything it logged.
 *
 * The injected logger captures both cerebro's own rendering (help, usage) and
 * the commands' output — `runCli` installs it as the command logger too, so
 * nothing reaches the real stdout. These assert the wiring: that `mcp` is
 * registered, that positionals and flags reach the handler, and that a bad
 * invocation fails with the message that says why. The handlers' behaviour is
 * covered directly in the sibling suites.
 */
const runMcp = async (argv: string[]): Promise<{ code: number; output: string }> => {
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => {
        lines.push(parts.map(String).join(" "));
    };

    const code = await runCli({
        argv,
        cwd: workdir,
        logger: { debug: record, error: record, info: record, log: record, warn: record } as unknown as Console,
    });

    return { code, output: lines.join("\n") };
};

describe("lunora mcp command wiring", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-mcp-handler-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("registers `mcp` as a command", async () => {
        expect.assertions(1);

        const { output } = await runMcp(["--help"]);

        expect(output).toContain("mcp");
    });

    it("rejects an unknown subcommand rather than doing something surprising", async () => {
        expect.assertions(2);

        const { code, output } = await runMcp(["mcp", "bogus"]);

        expect(code).toBe(EXIT_CODE.USAGE);
        expect(output).toContain("mcp: unknown subcommand. Usage: lunora mcp <install|uninstall|serve>");
    });

    it("rejects `mcp` with no subcommand", async () => {
        expect.assertions(2);

        const { code, output } = await runMcp(["mcp"]);

        expect(code).toBe(EXIT_CODE.USAGE);
        expect(output).toContain("mcp: unknown subcommand. Usage: lunora mcp <install|uninstall|serve>");
    });

    it("runs `install --list` end to end", async () => {
        expect.assertions(1);

        const { code } = await runMcp(["mcp", "install", "--list"]);

        expect(code).toBe(0);
    });

    it("passes positional client ids through to install", async () => {
        expect.assertions(2);

        // Reaching `resolveClients` at all is the point: the id it names back
        // is the proof the positional arrived rather than being swallowed.
        const { code, output } = await runMcp(["mcp", "install", "not-a-client"]);

        expect(code).toBe(EXIT_CODE.USAGE);
        expect(output).toContain('mcp install: unknown client "not-a-client"');
    });

    it("accepts --print alongside a client id", async () => {
        expect.assertions(2);

        const { code } = await runMcp(["mcp", "install", "claude-code", "--print"]);

        expect(code).toBe(0);
        // --print must not touch the filesystem, even through the real CLI.
        expect(existsSync(join(workdir, ".mcp.json"))).toBe(false);
    });
});
