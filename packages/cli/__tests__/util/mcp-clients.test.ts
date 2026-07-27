import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeDesktopPath, findMcpClient, MCP_CLIENT_IDS, MCP_CLIENTS } from "../../src/util/mcp-clients";

const context = (platform: NodeJS.Platform, scope: "global" | "project" = "global"): any => {
    return { home: "/home/u", platform, projectRoot: "/project", scope };
};

describe("claudeDesktopPath", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("resolves the macOS application-support location", () => {
        expect.assertions(1);

        expect(claudeDesktopPath(context("darwin"))).toBe("/home/u/Library/Application Support/Claude/claude_desktop_config.json");
    });

    it("resolves the Linux location", () => {
        expect.assertions(1);

        expect(claudeDesktopPath(context("linux"))).toBe("/home/u/.config/Claude/claude_desktop_config.json");
    });

    it("uses APPDATA on Windows", () => {
        expect.assertions(1);

        vi.stubEnv("APPDATA", String.raw`C:\Users\u\AppData\Roaming`);

        expect(claudeDesktopPath(context("win32"))).toContain("Claude");
    });

    it("gives up on Windows without APPDATA rather than guessing a path to write to", () => {
        expect.assertions(1);

        vi.stubEnv("APPDATA", "");

        expect(claudeDesktopPath(context("win32"))).toBeUndefined();
    });

    it("gives up on a platform whose convention we don't know", () => {
        expect.assertions(1);

        expect(claudeDesktopPath(context("freebsd"))).toBeUndefined();
    });

    it("has no project-scoped config at all", () => {
        expect.assertions(1);

        expect(claudeDesktopPath(context("darwin", "project"))).toBeUndefined();
    });
});

describe("the client table", () => {
    it("gives every client at least one resolvable config location", () => {
        expect.assertions(MCP_CLIENTS.length);

        for (const client of MCP_CLIENTS) {
            const paths = (["global", "project"] as const).map((scope) => client.configPath(context("darwin", scope)));

            // A client that resolves nothing anywhere could never be installed
            // into, and would silently drop out of `--list` and detection.
            expect(
                paths.some((path) => path !== undefined),
                `${client.id} resolves no config path`,
            ).toBe(true);
        }
    });

    it("keeps ids unique and findable, case-insensitively", () => {
        expect.assertions(3);

        expect(new Set(MCP_CLIENT_IDS).size).toBe(MCP_CLIENTS.length);
        expect(findMcpClient("CURSOR")?.id).toBe("cursor");
        expect(findMcpClient("nope")).toBeUndefined();
    });

    it("never emits a bare `url` for Gemini, which would be read as SSE", () => {
        expect.assertions(2);

        const gemini = findMcpClient("gemini");
        const entry = gemini?.format === "json" ? gemini.buildEntry({ transport: "http", url: "https://x/mcp" }) : {};

        expect(entry.httpUrl).toBe("https://x/mcp");
        expect(entry.url).toBeUndefined();
    });
});
