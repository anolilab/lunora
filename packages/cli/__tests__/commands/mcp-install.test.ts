import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_DOCS_MCP_URL, runMcpInstall, runMcpInstallList } from "../../src/commands/mcp/install";
import type { Logger } from "../../src/util/logger";

const captureLogger = (): { logger: Logger; messages: string[] } => {
    const messages: string[] = [];
    const record = (message: string): void => {
        messages.push(message);
    };

    return {
        logger: { error: record, info: record, success: record, warn: record },
        messages,
    };
};

let workdir: string;
let home: string;

/** Make `workdir` look like a Lunora project (a `lunora/` dir + a wrangler file). */
const makeProject = (): void => {
    mkdirSync(join(workdir, "lunora"), { recursive: true });
    writeFileSync(join(workdir, "wrangler.jsonc"), "{}", "utf8");
    writeFileSync(join(workdir, "package-lock.json"), "{}", "utf8");
};

const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

const baseOptions = (logger: Logger, overrides: Record<string, unknown> = {}): any => {
    return { clients: [], cwd: workdir, home, logger, platform: "darwin" as NodeJS.Platform, ...overrides };
};

describe("lunora mcp install", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-mcp-"));
        home = mkdtempSync(join(tmpdir(), "lunora-cli-home-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        rmSync(home, { force: true, recursive: true });
    });

    it("writes the hosted docs server into a named client", () => {
        expect.assertions(3);

        const { logger } = captureLogger();
        const result = runMcpInstall(baseOptions(logger, { clients: ["claude-code"] }));

        expect(result.code).toBe(0);

        const config = readJson(join(workdir, ".mcp.json"));

        expect(config.mcpServers["lunora-docs"]).toStrictEqual({ type: "http", url: DEFAULT_DOCS_MCP_URL });
        // Not a Lunora project, so only the docs server is installed.
        expect(config.mcpServers.lunora).toBeUndefined();
    });

    it("adds the local stdio server inside a Lunora project", () => {
        expect.assertions(3);

        makeProject();

        const { logger } = captureLogger();

        runMcpInstall(baseOptions(logger, { clients: ["claude-code"] }));

        const entry = readJson(join(workdir, ".mcp.json")).mcpServers.lunora;

        // A package-lock.json makes npm the detected manager, so the command is
        // routed through npx rather than a bare `lunora` that would not resolve.
        expect(entry.command).toBe("npx");
        expect(entry.args).toContain("lunora");
        expect(entry.args.slice(-2)).toStrictEqual(["mcp", "serve"]);
    });

    it("uses each client's own file, key and shape", () => {
        expect.assertions(4);

        const { logger } = captureLogger();

        runMcpInstall(baseOptions(logger, { clients: ["cursor", "vscode", "claude-desktop"] }));

        expect(readJson(join(workdir, ".cursor", "mcp.json")).mcpServers["lunora-docs"]).toBeDefined();
        // VS Code is the odd one out: `servers`, not `mcpServers`.
        expect(readJson(join(workdir, ".vscode", "mcp.json")).servers["lunora-docs"]).toBeDefined();
        expect(readJson(join(workdir, ".vscode", "mcp.json")).mcpServers).toBeUndefined();
        expect(readJson(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")).mcpServers["lunora-docs"]).toBeDefined();
    });

    it("preserves existing servers and comments in a config it edits", () => {
        expect.assertions(3);

        const path = join(workdir, ".mcp.json");

        writeFileSync(path, '{\n    // my own servers\n    "mcpServers": {\n        "other": { "command": "other" }\n    }\n}\n', "utf8");

        const { logger } = captureLogger();

        runMcpInstall(baseOptions(logger, { clients: ["claude-code"] }));

        const text = readFileSync(path, "utf8");

        expect(text).toContain("// my own servers");
        expect(text).toContain('"other"');
        expect(text).toContain('"lunora-docs"');
    });

    it("skips an entry that already exists unless --force is set", () => {
        expect.assertions(3);

        const path = join(workdir, ".mcp.json");

        writeFileSync(path, JSON.stringify({ mcpServers: { "lunora-docs": { url: "https://old.example/mcp" } } }, undefined, 4), "utf8");

        const { logger, messages } = captureLogger();
        const skipped = runMcpInstall(baseOptions(logger, { clients: ["claude-code"] }));

        expect(skipped.written[0]?.action).toBe("skipped");
        expect(messages.join("\n")).toContain("--force");

        runMcpInstall(baseOptions(logger, { clients: ["claude-code"], force: true }));

        expect(readJson(path).mcpServers["lunora-docs"].url).toBe(DEFAULT_DOCS_MCP_URL);
    });

    it("refuses to touch a config it cannot parse", () => {
        expect.assertions(3);

        const path = join(workdir, ".mcp.json");

        writeFileSync(path, "{ this is not json", "utf8");

        const { logger, messages } = captureLogger();
        const result = runMcpInstall(baseOptions(logger, { clients: ["claude-code"] }));

        expect(result.code).toBe(1);
        expect(readFileSync(path, "utf8")).toBe("{ this is not json");
        expect(messages.join("\n")).toContain("not valid JSON");
    });

    it("prints a paste-in snippet for a client whose config is not JSON", () => {
        expect.assertions(2);

        const { logger, messages } = captureLogger();

        runMcpInstall(baseOptions(logger, { clients: ["codex"] }));

        expect(messages.join("\n")).toContain("[mcp_servers.lunora-docs]");
        expect(existsSync(join(home, ".codex"))).toBe(false);
    });

    it("writes nothing with --print", () => {
        expect.assertions(3);

        const { logger, messages } = captureLogger();
        const result = runMcpInstall(baseOptions(logger, { clients: ["claude-code"], print: true }));

        expect(result.written[0]?.action).toBe("printed");
        expect(existsSync(join(workdir, ".mcp.json"))).toBe(false);
        expect(messages.join("\n")).toContain("lunora-docs");
    });

    it("honours --docs-url and --docs-only", () => {
        expect.assertions(2);

        makeProject();

        const { logger } = captureLogger();

        runMcpInstall(baseOptions(logger, { clients: ["claude-code"], docsOnly: true, docsUrl: "http://localhost:5173/mcp" }));

        const servers = readJson(join(workdir, ".mcp.json")).mcpServers;

        expect(servers["lunora-docs"].url).toBe("http://localhost:5173/mcp");
        expect(servers.lunora).toBeUndefined();
    });

    it("fails when --local-only is set outside a Lunora project", () => {
        expect.assertions(2);

        const { logger, messages } = captureLogger();
        const result = runMcpInstall(baseOptions(logger, { clients: ["claude-code"], localOnly: true }));

        expect(result.code).toBe(1);
        expect(messages.join("\n")).toContain("not a Lunora project");
    });

    it("rejects an unknown client id and lists the known ones", () => {
        expect.assertions(2);

        const { logger, messages } = captureLogger();
        const result = runMcpInstall(baseOptions(logger, { clients: ["emacs"] }));

        expect(result.code).toBe(1);
        expect(messages.join("\n")).toContain("claude-code");
    });

    it("installs into every already-configured client when none is named", () => {
        expect.assertions(3);

        mkdirSync(join(workdir, ".cursor"), { recursive: true });
        writeFileSync(join(workdir, ".cursor", "mcp.json"), "{}", "utf8");

        const { logger } = captureLogger();
        const result = runMcpInstall(baseOptions(logger));

        expect(result.written.map((entry) => entry.client)).toStrictEqual(["cursor"]);
        expect(readJson(join(workdir, ".cursor", "mcp.json")).mcpServers["lunora-docs"]).toBeDefined();
        expect(existsSync(join(workdir, ".mcp.json"))).toBe(false);
    });

    it("asks for an explicit client when it cannot detect one", () => {
        expect.assertions(2);

        const { logger, messages } = captureLogger();
        const result = runMcpInstall(baseOptions(logger));

        expect(result.code).toBe(1);
        expect(messages.join("\n")).toContain("no MCP client config found");
    });

    it("--list names every supported client", () => {
        expect.assertions(2);

        const { logger, messages } = captureLogger();
        const result = runMcpInstallList({ cwd: workdir, home, logger, platform: "darwin" });

        expect(result.code).toBe(0);
        expect(messages.join("\n")).toContain("windsurf");
    });
});
