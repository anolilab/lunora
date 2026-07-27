import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMcpInstall } from "../../src/commands/mcp/install";
import { runMcpUninstall } from "../../src/commands/mcp/uninstall";
import type { Logger } from "../../src/util/logger";

const captureLogger = (): { logger: Logger; messages: string[] } => {
    const messages: string[] = [];
    const record = (message: string): void => {
        messages.push(message);
    };

    return { logger: { error: record, info: record, success: record, warn: record }, messages };
};

let workdir: string;
let home: string;

const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

const options = (logger: Logger, overrides: Record<string, unknown> = {}): any => {
    return { clients: [], cwd: workdir, home, logger, platform: "darwin" as NodeJS.Platform, ...overrides };
};

describe("lunora mcp uninstall", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-mcp-un-"));
        home = mkdtempSync(join(tmpdir(), "lunora-cli-home-un-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        rmSync(home, { force: true, recursive: true });
    });

    it("removes what install wrote — the round trip", () => {
        expect.assertions(3);

        const { logger } = captureLogger();

        runMcpInstall(options(logger, { clients: ["cursor"] }));

        // The docs server prefers the global config.
        const globalPath = join(home, ".cursor", "mcp.json");

        expect(readJson(globalPath).mcpServers["lunora-docs"]).toBeDefined();

        const result = runMcpUninstall(options(logger, { clients: ["cursor"] }));

        expect(result.code).toBe(0);
        expect(readJson(globalPath).mcpServers["lunora-docs"]).toBeUndefined();
    });

    it("leaves the user's other servers, comments and formatting alone", () => {
        expect.assertions(3);

        const path = join(workdir, ".mcp.json");

        writeFileSync(
            path,
            '{\n    // my own servers\n    "mcpServers": {\n        "other": { "command": "other" },\n        "lunora-docs": { "url": "https://lunora.sh/mcp" }\n    }\n}\n',
            "utf8",
        );

        const { logger } = captureLogger();

        runMcpUninstall(options(logger, { clients: ["claude-code"] }));

        const text = readFileSync(path, "utf8");

        expect(text).toContain("// my own servers");
        expect(text).toContain('"other"');
        expect(text).not.toContain("lunora-docs");
    });

    it("is idempotent — removing twice is not an error", () => {
        expect.assertions(2);

        const { logger } = captureLogger();

        runMcpInstall(options(logger, { clients: ["claude-code"] }));

        expect(runMcpUninstall(options(logger, { clients: ["claude-code"] })).code).toBe(0);
        expect(runMcpUninstall(options(logger, { clients: ["claude-code"] })).code).toBe(0);
    });

    it("says so when there was nothing configured", () => {
        expect.assertions(1);

        const { logger, messages } = captureLogger();

        runMcpUninstall(options(logger, { clients: ["claude-code"] }));

        expect(messages.join("\n")).toContain("Nothing to remove");
    });

    it("checks every client by default, since a leftover entry is the failure a user notices", () => {
        expect.assertions(2);

        const { logger } = captureLogger();

        runMcpInstall(options(logger, { clients: ["cursor", "claude-code"] }));
        runMcpUninstall(options(logger));

        expect(readJson(join(home, ".cursor", "mcp.json")).mcpServers["lunora-docs"]).toBeUndefined();
        expect(readJson(join(home, ".claude.json")).mcpServers["lunora-docs"]).toBeUndefined();
    });

    it("honours --docs-only", () => {
        expect.assertions(2);

        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), "{}", "utf8");
        writeFileSync(join(workdir, "package-lock.json"), "{}", "utf8");

        const { logger } = captureLogger();

        runMcpInstall(options(logger, { clients: ["claude-code"] }));
        runMcpUninstall(options(logger, { clients: ["claude-code"], docsOnly: true }));

        expect(readJson(join(home, ".claude.json")).mcpServers["lunora-docs"]).toBeUndefined();
        // The project-scoped local server survives.
        expect(readJson(join(workdir, ".mcp.json")).mcpServers.lunora).toBeDefined();
    });

    it("reports a config it cannot parse instead of destroying it", () => {
        expect.assertions(2);

        const path = join(workdir, ".mcp.json");

        writeFileSync(path, "{ not json", "utf8");

        const { logger } = captureLogger();
        const result = runMcpUninstall(options(logger, { clients: ["claude-code"] }));

        expect(result.code).toBe(1);
        expect(readFileSync(path, "utf8")).toBe("{ not json");
    });

    it("rejects an unknown client id", () => {
        expect.assertions(1);

        const { logger } = captureLogger();

        expect(runMcpUninstall(options(logger, { clients: ["emacs"] })).code).toBe(1);
    });

    it("leaves no temp file behind", () => {
        expect.assertions(1);

        const { logger } = captureLogger();

        runMcpInstall(options(logger, { clients: ["claude-code"] }));
        runMcpUninstall(options(logger, { clients: ["claude-code"] }));

        expect(existsSync(join(home, ".claude.json.lunora-tmp"))).toBe(false);
    });
});
