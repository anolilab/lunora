import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
        expect(readJson(join(workdir, ".mcp.json")).mcpServers["lunora-docs"]).toBeUndefined();
    });

    it("honours --docs-only", () => {
        expect.assertions(2);

        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), "{}", "utf8");
        writeFileSync(join(workdir, "package-lock.json"), "{}", "utf8");

        const { logger } = captureLogger();

        runMcpInstall(options(logger, { clients: ["claude-code"] }));
        runMcpUninstall(options(logger, { clients: ["claude-code"], docsOnly: true }));

        expect(readJson(join(workdir, ".mcp.json")).mcpServers["lunora-docs"]).toBeUndefined();
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

        expect(existsSync(join(workdir, ".mcp.json.lunora-tmp"))).toBe(false);
    });
});

describe("config-file safety", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-mcp-safe-"));
        home = mkdtempSync(join(tmpdir(), "lunora-cli-home-safe-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        rmSync(home, { force: true, recursive: true });
    });

    it("preserves a private config's mode instead of widening it", () => {
        expect.assertions(2);

        const path = join(workdir, ".mcp.json");

        writeFileSync(path, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
        chmodSync(path, 0o600);

        const { logger } = captureLogger();

        runMcpInstall(options(logger, { clients: ["claude-code"], scope: "project" }));

        // These files hold `env` blocks full of API tokens, which is why they
        // are 0600. A temp-file-then-rename that forgets the mode publishes them.
        // eslint-disable-next-line no-bitwise -- masking the permission bits out of a stat mode is what the check is
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(readJson(path).mcpServers["lunora-docs"]).toBeDefined();
    });

    it("writes through a symlinked config rather than replacing the link", () => {
        expect.assertions(3);

        const real = join(home, "dotfiles-mcp.json");
        const link = join(workdir, ".mcp.json");

        writeFileSync(real, JSON.stringify({ mcpServers: {} }), "utf8");
        symlinkSync(real, link);

        const { logger } = captureLogger();

        runMcpInstall(options(logger, { clients: ["claude-code"], scope: "project" }));

        // Dotfile managers symlink exactly these paths; replacing the link
        // leaves the repo copy stale while still reading as clean.
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readJson(real).mcpServers["lunora-docs"]).toBeDefined();
        expect(readJson(link).mcpServers["lunora-docs"]).toBeDefined();
    });

    it("leaves no temp file behind, and does not reuse a predictable one", () => {
        expect.assertions(2);

        const { logger } = captureLogger();

        runMcpInstall(options(logger, { clients: ["claude-code"], scope: "project" }));

        expect(existsSync(join(workdir, ".mcp.json.lunora-tmp"))).toBe(false);
        expect(readdirSync(workdir).filter((name) => name.includes(".tmp"))).toHaveLength(0);
    });
});

describe("dry run and scope", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-mcp-dry-"));
        home = mkdtempSync(join(tmpdir(), "lunora-cli-home-dry-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        rmSync(home, { force: true, recursive: true });
    });

    it("--print reports what it would remove and changes nothing", () => {
        expect.assertions(3);

        const { logger, messages } = captureLogger();

        runMcpInstall(options(logger, { clients: ["cursor"] }));
        const result = runMcpUninstall(options(logger, { clients: ["cursor"], print: true }));

        expect(result.removed).toHaveLength(1);
        expect(messages.join("\n")).toContain("would remove");
        // The command with the widest blast radius must be rehearsable.
        expect(readJson(join(home, ".cursor", "mcp.json")).mcpServers["lunora-docs"]).toBeDefined();
    });

    it("honours --project instead of silently ignoring it", () => {
        expect.assertions(2);

        const { logger } = captureLogger();

        runMcpInstall(options(logger, { clients: ["cursor"] }));
        runMcpInstall(options(logger, { clients: ["cursor"], scope: "project" }));
        runMcpUninstall(options(logger, { clients: ["cursor"], scope: "project" }));

        expect(readJson(join(workdir, ".cursor", "mcp.json")).mcpServers["lunora-docs"]).toBeUndefined();
        // The global copy is untouched by a project-scoped removal.
        expect(readJson(join(home, ".cursor", "mcp.json")).mcpServers["lunora-docs"]).toBeDefined();
    });

    it("refuses --docs-only with --local-only rather than reporting a false 'nothing to remove'", () => {
        expect.assertions(2);

        const { logger, messages } = captureLogger();
        const result = runMcpUninstall(options(logger, { docsOnly: true, localOnly: true }));

        expect(result.code).toBe(1);
        expect(messages.join("\n")).toContain("mutually exclusive");
    });
});
