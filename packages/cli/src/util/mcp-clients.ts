/**
 * Where each MCP client keeps its server list, and what an entry looks like
 * there.
 *
 * Every client agreed on the protocol and then invented its own config file:
 * different path, different top-level key, sometimes a different entry shape.
 * That difference is the whole reason `lunora mcp install` exists — a user
 * should not have to know that VS Code says `servers` while Cursor says
 * `mcpServers`. This module is the table of those differences; the command is a
 * thin loop over it.
 *
 * Clients whose config is not JSON (Codex, which uses TOML) are listed as
 * `manual`: the command prints the exact snippet and the path to paste it into
 * rather than guessing at a format it cannot safely rewrite.
 */
import { join } from "@visulima/path";

/** How a client is told to reach an MCP server. */
type McpServerSpec =
    | {
          args: ReadonlyArray<string>;
          command: string;
          env?: Record<string, string>;
          transport: "stdio";
      }
    | { transport: "http"; url: string };

/** Inputs a client's config path depends on. */
interface McpPathContext {
    /** The user's home directory. */
    home: string;
    /** `process.platform`. */
    platform: NodeJS.Platform;
    /** The project the command was run in. */
    projectRoot: string;
}

interface McpClientBase {
    /** Stable id the user types: `lunora mcp install cursor`. */
    id: string;
    /** Display name for messages. */
    label: string;

    /**
     * `"project"` configs live in the repository and are shared with the team
     * (and should be committed); `"user"` configs are per-machine.
     */
    scope: "project" | "user";
}

interface JsonMcpClient extends McpClientBase {
    /**
     * The client's entry shape, or `undefined` when it cannot express this
     * transport (e.g. a client with no remote-server support).
     */
    buildEntry: (spec: McpServerSpec) => Record<string, unknown> | undefined;
    /** Absolute path of the config file, or `undefined` on an unsupported platform. */
    configPath: (context: McpPathContext) => string | undefined;
    format: "json";
    /** Top-level key holding the map of server name → entry. */
    key: string;
}

interface ManualMcpClient extends McpClientBase {
    /** Human description of the file to paste into, e.g. `"~/.codex/config.toml"`. */
    configHint: string;
    format: "manual";
    /** The snippet to paste. */
    renderSnippet: (name: string, spec: McpServerSpec) => string;
}

type McpClient = JsonMcpClient | ManualMcpClient;

/**
 * The `{ command, args, env }` / `{ url }` entry shape that Claude Code, Claude
 * Desktop, Cursor, Windsurf, and the Gemini CLI all share.
 */
const standardEntry = (spec: McpServerSpec): Record<string, unknown> => {
    if (spec.transport === "http") {
        return { type: "http", url: spec.url };
    }

    return {
        args: [...spec.args],
        command: spec.command,
        ...(spec.env === undefined ? {} : { env: spec.env }),
    };
};

/**
 * Claude Desktop stores its config under the OS application-data directory,
 * which differs per platform. Returns `undefined` where we don't know the
 * convention rather than writing to a plausible-looking wrong path.
 */
const claudeDesktopPath = ({ home, platform }: McpPathContext): string | undefined => {
    if (platform === "darwin") {
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    }

    if (platform === "win32") {
        const appData = process.env["APPDATA"];

        return appData === undefined || appData === "" ? undefined : join(appData, "Claude", "claude_desktop_config.json");
    }

    if (platform === "linux") {
        return join(home, ".config", "Claude", "claude_desktop_config.json");
    }

    return undefined;
};

/** Render a TOML `[mcp_servers.&lt;name>]` table — Codex's config format. */
const codexSnippet = (name: string, spec: McpServerSpec): string => {
    if (spec.transport === "http") {
        return `[mcp_servers.${name}]\nurl = "${spec.url}"\n`;
    }

    const args = spec.args.map((argument) => `"${argument}"`).join(", ");
    const environment =
        spec.env === undefined
            ? ""
            : `env = { ${Object.entries(spec.env)
                  .map(([key, value]) => `${key} = "${value}"`)
                  .join(", ")} }\n`;

    return `[mcp_servers.${name}]\ncommand = "${spec.command}"\nargs = [${args}]\n${environment}`;
};

/**
 * The supported clients, in the order `lunora mcp install --list` prints them:
 * project-scoped first (a teammate gets them by checking out the repo), then
 * per-machine ones.
 */
const MCP_CLIENTS: ReadonlyArray<McpClient> = [
    {
        buildEntry: standardEntry,
        configPath: ({ projectRoot }) => join(projectRoot, ".mcp.json"),
        format: "json",
        id: "claude-code",
        key: "mcpServers",
        label: "Claude Code",
        scope: "project",
    },
    {
        buildEntry: standardEntry,
        configPath: ({ projectRoot }) => join(projectRoot, ".cursor", "mcp.json"),
        format: "json",
        id: "cursor",
        key: "mcpServers",
        label: "Cursor",
        scope: "project",
    },
    {
        buildEntry: standardEntry,
        configPath: ({ projectRoot }) => join(projectRoot, ".vscode", "mcp.json"),
        format: "json",
        id: "vscode",
        // VS Code is the odd one out: `servers`, not `mcpServers`.
        key: "servers",
        label: "VS Code (GitHub Copilot)",
        scope: "project",
    },
    {
        buildEntry: standardEntry,
        configPath: ({ projectRoot }) => join(projectRoot, ".gemini", "settings.json"),
        format: "json",
        id: "gemini",
        key: "mcpServers",
        label: "Gemini CLI",
        scope: "project",
    },
    {
        buildEntry: standardEntry,
        configPath: claudeDesktopPath,
        format: "json",
        id: "claude-desktop",
        key: "mcpServers",
        label: "Claude Desktop",
        scope: "user",
    },
    {
        buildEntry: standardEntry,
        configPath: ({ home }) => join(home, ".codeium", "windsurf", "mcp_config.json"),
        format: "json",
        id: "windsurf",
        key: "mcpServers",
        label: "Windsurf",
        scope: "user",
    },
    {
        configHint: "~/.codex/config.toml",
        format: "manual",
        id: "codex",
        label: "Codex CLI",
        renderSnippet: codexSnippet,
        scope: "user",
    },
];

const MCP_CLIENT_IDS: ReadonlyArray<string> = MCP_CLIENTS.map((client) => client.id);

const findMcpClient = (id: string): McpClient | undefined => MCP_CLIENTS.find((client) => client.id === id.toLowerCase());

export type { JsonMcpClient, ManualMcpClient, McpClient, McpPathContext, McpServerSpec };
export { claudeDesktopPath, codexSnippet, findMcpClient, MCP_CLIENT_IDS, MCP_CLIENTS, standardEntry };
