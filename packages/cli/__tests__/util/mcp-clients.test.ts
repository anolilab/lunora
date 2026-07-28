import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpPathContext } from "../../src/util/mcp-clients";
import { claudeDesktopPaths, findMcpClient, MCP_CLIENT_IDS, MCP_CLIENTS } from "../../src/util/mcp-clients";

const context = (platform: NodeJS.Platform): McpPathContext => {
    return { home: "/home/u", platform, projectRoot: "/project" };
};

describe("claudeDesktopPath", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("resolves the macOS application-support location", () => {
        expect.assertions(1);

        expect(claudeDesktopPaths(context("darwin")).global).toBe("/home/u/Library/Application Support/Claude/claude_desktop_config.json");
    });

    it("resolves the Linux location", () => {
        expect.assertions(1);

        expect(claudeDesktopPaths(context("linux")).global).toBe("/home/u/.config/Claude/claude_desktop_config.json");
    });

    it("uses APPDATA on Windows", () => {
        expect.assertions(1);

        vi.stubEnv("APPDATA", String.raw`C:\Users\u\AppData\Roaming`);

        expect(claudeDesktopPaths(context("win32")).global).toContain("Claude");
    });

    it("gives up on Windows without APPDATA rather than guessing a path to write to", () => {
        expect.assertions(1);

        vi.stubEnv("APPDATA", "");

        expect(claudeDesktopPaths(context("win32")).global).toBeUndefined();
    });

    it("gives up on a platform whose convention we don't know", () => {
        expect.assertions(1);

        expect(claudeDesktopPaths(context("freebsd")).global).toBeUndefined();
    });

    it("has no project-scoped config at all", () => {
        expect.assertions(1);

        expect(claudeDesktopPaths(context("darwin")).project).toBeUndefined();
    });
});

describe("the client table", () => {
    it("gives every client at least one resolvable config location", () => {
        // Not a literal count: the assertion runs once per client, and the table
        // grows.
        expect.hasAssertions();

        for (const client of MCP_CLIENTS) {
            // A client that declares no file anywhere could never be installed
            // into, and would silently drop out of `--list` and detection.
            expect(Object.keys(client.paths(context("darwin"))), `${client.id} declares no config path`).not.toHaveLength(0);
        }
    });

    it("keeps ids unique and findable, case-insensitively", () => {
        expect.assertions(3);

        expect(new Set(MCP_CLIENT_IDS).size).toBe(MCP_CLIENTS.length);
        expect(findMcpClient("CURSOR")?.id).toBe("cursor");
        expect(findMcpClient("nope")).toBeUndefined();
    });

    /**
     * These are the shapes verified against each vendor's own documentation.
     * Getting one wrong writes a config that lands, reports success, and never
     * connects — so pin them here, next to the rule that says to check the docs,
     * rather than only indirectly through filesystem round trips.
     */
    it.each([
        ["gemini", { httpUrl: "https://x/mcp" }],
        ["windsurf", { serverUrl: "https://x/mcp" }],
        ["zed", { url: "https://x/mcp" }],
        ["cline", { disabled: false, type: "streamableHttp", url: "https://x/mcp" }],
        ["claude-code", { type: "http", url: "https://x/mcp" }],
        ["claude-desktop", { args: ["-y", "mcp-remote", "https://x/mcp"], command: "npx" }],
        ["opencode", { enabled: true, type: "remote", url: "https://x/mcp" }],
    ])("writes %s's documented remote shape", (id, expected) => {
        expect.assertions(1);

        const client = findMcpClient(id);

        expect(client?.format === "json" ? client.buildEntry({ transport: "http", url: "https://x/mcp" }) : undefined).toStrictEqual(expected);
    });
});
