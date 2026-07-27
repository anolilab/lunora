import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LocalMcpServerOptions } from "@lunora/mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { devTools, MAX_LOG_LINES } from "../../src/commands/mcp/dev-tools";
import { resolveDeployment, runMcpServe } from "../../src/commands/mcp/serve";

let workdir: string;

/**
 * Record a live dev server for `workdir`. Uses this process's own PID so the
 * liveness check in `readLiveDevServerState` passes without spawning anything.
 */
const recordDevServer = (state: Record<string, unknown> = {}): void => {
    mkdirSync(join(workdir, ".lunora"), { recursive: true });
    writeFileSync(
        join(workdir, ".lunora", "dev.json"),
        JSON.stringify({ mode: "cli", pid: process.pid, startedAt: new Date().toISOString(), url: "http://localhost:8787", ...state }),
        "utf8",
    );
};

const textOf = (result: { content: { text: string }[] }): string => result.content.map((part) => part.text).join("");

const toolNamed = (name: string): { handle: (input: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> } => {
    const tool = devTools(workdir).find((entry) => entry.definition.name === name);

    if (tool === undefined) {
        throw new Error(`no dev tool named ${name}`);
    }

    return tool;
};

describe("lunora mcp serve", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-mcp-serve-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        vi.unstubAllEnvs();
    });

    describe("deployment resolution", () => {
        it("returns nothing when no dev server is recorded", () => {
            expect.assertions(1);

            expect(resolveDeployment({ cwd: workdir, version: "1.0.0" })).toBeUndefined();
        });

        it("finds the running dev server and its admin token", () => {
            expect.assertions(1);

            recordDevServer();
            // eslint-disable-next-line no-secrets/no-secrets -- a throwaway .dev.vars fixture in a temp directory, not a credential
            writeFileSync(join(workdir, ".dev.vars"), 'LUNORA_ADMIN_TOKEN="local"\n', "utf8");
            vi.stubEnv("LUNORA_ADMIN_TOKEN", "");

            expect(resolveDeployment({ cwd: workdir, version: "1.0.0" })).toStrictEqual({ token: "local", url: "http://localhost:8787" });
        });

        it("omits the token when .dev.vars has none, rather than sending an empty one", () => {
            expect.assertions(1);

            recordDevServer();
            vi.stubEnv("LUNORA_ADMIN_TOKEN", "");

            expect(resolveDeployment({ cwd: workdir, version: "1.0.0" })).toStrictEqual({ url: "http://localhost:8787" });
        });

        it("prefers the explicit --url and --token overrides", () => {
            expect.assertions(1);

            recordDevServer();

            expect(resolveDeployment({ cwd: workdir, token: "flag-token", url: "https://staging.example", version: "1.0.0" })).toStrictEqual({
                token: "flag-token",
                url: "https://staging.example",
            });
        });
    });

    describe("startup", () => {
        it("passes a resolver, not a fixed deployment, so a later `lunora dev` is picked up", async () => {
            expect.assertions(3);

            const connect = vi.fn<(options: LocalMcpServerOptions) => Promise<unknown>>(async () => undefined);
            const result = await runMcpServe({ cwd: workdir, version: "1.2.3", writeError: () => undefined }, connect);

            expect(result.code).toBe(0);

            const passed = connect.mock.calls[0]?.[0];

            expect(typeof passed?.deployment).toBe("function");

            // Nothing was running at startup; the resolver sees the server that
            // appears afterwards without the process being restarted.
            recordDevServer();

            expect((passed?.deployment as () => unknown)()).toStrictEqual({ url: "http://localhost:8787" });
        });

        it("is read-only unless --allow-writes is passed", async () => {
            expect.assertions(2);

            const connect = vi.fn<(options: LocalMcpServerOptions) => Promise<unknown>>(async () => undefined);

            await runMcpServe({ cwd: workdir, version: "1.0.0", writeError: () => undefined }, connect);

            expect(connect.mock.calls[0]?.[0].allowWrites).toBe(false);

            await runMcpServe({ allowWrites: true, cwd: workdir, version: "1.0.0", writeError: () => undefined }, connect);

            expect(connect.mock.calls[1]?.[0].allowWrites).toBe(true);
        });

        it("writes its diagnostics to the error sink, never to the MCP wire", async () => {
            expect.assertions(2);

            const written: string[] = [];
            const connect = async (): Promise<unknown> => undefined;

            recordDevServer();

            await runMcpServe({ cwd: workdir, version: "1.0.0", writeError: (message) => written.push(message) }, connect);

            expect(written.join("")).toContain("http://localhost:8787");
            expect(written.join("")).toContain("ready");
        });

        it("reports a startup failure as a non-zero exit", async () => {
            expect.assertions(2);

            const written: string[] = [];
            const connect = async (): Promise<unknown> => {
                throw new Error("stdio unavailable");
            };

            const result = await runMcpServe({ cwd: workdir, version: "1.0.0", writeError: (message) => written.push(message) }, connect);

            expect(result.code).toBe(1);
            expect(written.join("")).toContain("stdio unavailable");
        });

        it("drops the documentation tools with --no-docs", async () => {
            expect.assertions(1);

            const connect = vi.fn<(options: LocalMcpServerOptions) => Promise<unknown>>(async () => undefined);

            await runMcpServe({ cwd: workdir, noDocs: true, version: "1.0.0", writeError: () => undefined }, connect);

            expect(connect.mock.calls[0]?.[0].docs).toBe(false);
        });
    });
});

describe("dev tools", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-mcp-dev-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports that nothing is running, with the command that starts it", async () => {
        expect.assertions(2);

        const result = await toolNamed("lunora_dev_status").handle({});
        const parsed = JSON.parse(textOf(result)) as { hint: string; running: boolean };

        expect(parsed.running).toBe(false);
        expect(parsed.hint).toContain("lunora dev");
    });

    it("reports the running server's url, studio url and mode", async () => {
        expect.assertions(3);

        recordDevServer({ studioUrl: "http://localhost:6173" });

        const parsed = JSON.parse(textOf(await toolNamed("lunora_dev_status").handle({}))) as Record<string, unknown>;

        expect(parsed.running).toBe(true);
        expect(parsed.url).toBe("http://localhost:8787");
        expect(parsed.studioUrl).toBe("http://localhost:6173");
    });

    it("tails the captured log", async () => {
        expect.assertions(2);

        const logFile = join(workdir, ".lunora", "dev.log");

        recordDevServer({ logFile });
        writeFileSync(logFile, Array.from({ length: 10 }, (_, index) => `line ${String(index)}`).join("\n"), "utf8");

        const result = await toolNamed("lunora_dev_logs").handle({ lines: 3 });

        expect(result.isError).toBeUndefined();
        expect(textOf(result)).toBe("line 7\nline 8\nline 9");
    });

    it("clamps the requested line count", async () => {
        expect.assertions(1);

        const logFile = join(workdir, ".lunora", "dev.log");

        recordDevServer({ logFile });
        writeFileSync(logFile, Array.from({ length: MAX_LOG_LINES + 50 }, (_, index) => String(index)).join("\n"), "utf8");

        const result = await toolNamed("lunora_dev_logs").handle({ lines: 99_999 });

        expect(textOf(result).split("\n")).toHaveLength(MAX_LOG_LINES);
    });

    it("explains that a foreground dev server has no readable log", async () => {
        expect.assertions(2);

        recordDevServer();

        const result = await toolNamed("lunora_dev_logs").handle({});

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("--background");
    });

    it("says so when no server is running at all", async () => {
        expect.assertions(2);

        const result = await toolNamed("lunora_dev_logs").handle({});

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("lunora dev");
    });
});
