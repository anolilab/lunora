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
 *
 * ## On where these shapes come from
 *
 * The Gemini (`httpUrl`) and Windsurf (`serverUrl`) forms are verified against
 * those tools' own documentation — a bare `url` means SSE to Gemini, which this
 * server does not speak, so getting it wrong writes a config that silently
 * never connects.
 *
 * The Zed, OpenCode and Cline forms are adapted from
 * [`add-mcp`](https://www.npmjs.com/package/add-mcp) (Apache-2.0), which
 * maintains this matrix across 16 agents. They are marked as such at each
 * builder because they are NOT independently verified — and add-mcp is not
 * infallible here: it writes `{type, url}` for Gemini, which that CLI reads as
 * SSE. Verify against the client's docs before trusting one of these.
 */
import { join } from "@visulima/path";
import { stringify } from "smol-toml";

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
    /**
     * Absolute path of the config file, or `undefined` on a platform whose
     * convention we don't know.
     *
     * Every client has one, including the ones we don't rewrite: detection ("is
     * this client actually set up here?") is the same question regardless of the
     * file's format, and hanging it off the format discriminant is what made
     * Codex undetectable.
     */
    configPath: (context: McpPathContext) => string | undefined;
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

/** A client whose config we can safely read-modify-write. */
interface JsonMcpClient extends McpClientBase {
    /** The client's entry shape for a server. */
    buildEntry: (spec: McpServerSpec) => Record<string, unknown>;
    format: "json";
    /** Top-level key holding the map of server name → entry. */
    key: string;
}

/** A client whose config we only print a snippet for — see {@link MCP_CLIENTS}. */
interface ManualMcpClient extends McpClientBase {
    format: "manual";
    /** The snippet to paste. */
    renderSnippet: (name: string, spec: McpServerSpec) => string;
}

type McpClient = JsonMcpClient | ManualMcpClient;

/**
 * The stdio entry every client understands: `{ command, args, env }`.
 *
 * The remote shape is where they diverge, so each client pairs this with its
 * own — see {@link standardEntry} and the builders below.
 */
const stdioEntry = (spec: Extract<McpServerSpec, { transport: "stdio" }>): Record<string, unknown> => {
    return {
        args: [...spec.args],
        command: spec.command,
        ...(spec.env === undefined ? {} : { env: spec.env }),
    };
};

/**
 * Claude Code, Cursor and VS Code: a remote server is `{ type: "http", url }`.
 *
 * This is NOT the universal shape it looks like. Getting it wrong is worse than
 * failing to write anything, because the config lands, we report success, and
 * the user discovers months later that the server never connected — so each
 * client below spells out its own remote form rather than sharing this one.
 */
const standardEntry = (spec: McpServerSpec): Record<string, unknown> => (spec.transport === "http" ? { type: "http", url: spec.url } : stdioEntry(spec));

/**
 * Gemini CLI selects the transport by *property name*, ignoring `type`:
 * `httpUrl` is Streamable HTTP, while a bare `url` means SSE — which this server
 * does not speak.
 */
const geminiEntry = (spec: McpServerSpec): Record<string, unknown> => (spec.transport === "http" ? { httpUrl: spec.url } : stdioEntry(spec));

/** Windsurf names the Streamable-HTTP endpoint `serverUrl`. */
const windsurfEntry = (spec: McpServerSpec): Record<string, unknown> => (spec.transport === "http" ? { serverUrl: spec.url } : stdioEntry(spec));

/**
 * Bridge a remote server through `mcp-remote`, the documented stdio shim, for
 * clients that only validate stdio entries.
 */
const bridgedEntry = (url: string): Record<string, unknown> => {
    return { args: ["-y", "mcp-remote", url], command: "npx" };
};

/**
 * Claude Desktop validates stdio entries only — remote servers go through
 * Custom Connectors, not this file. Rather than write an entry it will ignore,
 * point it at the `mcp-remote` bridge.
 */
const claudeDesktopEntry = (spec: McpServerSpec): Record<string, unknown> => (spec.transport === "http" ? bridgedEntry(spec.url) : stdioEntry(spec));

/**
 * Zed keys its servers under `context_servers` and tags each with `source`.
 *
 * Shape adapted from `add-mcp` (Apache-2.0), which maintains a client matrix
 * across 16 agents; not independently verified against Zed's docs, unlike the
 * Gemini and Windsurf shapes above.
 */
const zedEntry = (spec: McpServerSpec): Record<string, unknown> =>
    spec.transport === "http" ? { source: "custom", type: "http", url: spec.url } : { source: "custom", ...stdioEntry(spec) };

/**
 * OpenCode discriminates on an explicit `type`, and takes the whole command
 * line as one array rather than `command` + `args`.
 *
 * Shape adapted from `add-mcp` (Apache-2.0); not independently verified.
 */
const openCodeEntry = (spec: McpServerSpec): Record<string, unknown> =>
    spec.transport === "http"
        ? { enabled: true, type: "remote", url: spec.url }
        : { command: [spec.command, ...spec.args], enabled: true, type: "local", ...(spec.env === undefined ? {} : { environment: spec.env }) };

/**
 * Cline spells Streamable HTTP `streamableHttp` and carries an explicit
 * `disabled` flag.
 *
 * Shape adapted from `add-mcp` (Apache-2.0); not independently verified.
 */
const clineEntry = (spec: McpServerSpec): Record<string, unknown> =>
    spec.transport === "http" ? { disabled: false, type: "streamableHttp", url: spec.url } : { disabled: false, ...stdioEntry(spec) };

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

/**
 * Render the `[mcp_servers.&lt;name>]` table Codex reads.
 *
 * Serialized by `smol-toml` rather than by hand: TOML has real rules about
 * which keys may be bare (a dot in a server name silently becomes table
 * nesting) and which characters a basic string may contain (a raw newline in an
 * env value is invalid). Hand-rolling that is a bug farm, and the library is
 * already in the tree — wrangler depends on it.
 */
const codexSnippet = (name: string, spec: McpServerSpec): string =>
    stringify({
        mcp_servers: {
            [name]:
                spec.transport === "http"
                    ? { url: spec.url }
                    : { args: [...spec.args], command: spec.command, ...(spec.env === undefined ? {} : { env: spec.env }) },
        },
    });

/**
 * The supported clients, in the order `lunora mcp install --list` prints them:
 * project-scoped first (a teammate gets them by checking out the repo), then
 * per-machine ones.
 *
 * Codex is `manual` because its config is TOML: merging into it would mean
 * carrying a TOML parser that preserves formatting, and a bad merge silently
 * corrupts a file we don't own. Printing the snippet is the honest trade.
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
        buildEntry: geminiEntry,
        configPath: ({ projectRoot }) => join(projectRoot, ".gemini", "settings.json"),
        format: "json",
        id: "gemini",
        key: "mcpServers",
        label: "Gemini CLI",
        scope: "project",
    },
    {
        buildEntry: claudeDesktopEntry,
        configPath: claudeDesktopPath,
        format: "json",
        id: "claude-desktop",
        key: "mcpServers",
        label: "Claude Desktop",
        scope: "user",
    },
    {
        buildEntry: windsurfEntry,
        configPath: ({ home }) => join(home, ".codeium", "windsurf", "mcp_config.json"),
        format: "json",
        id: "windsurf",
        key: "mcpServers",
        label: "Windsurf",
        scope: "user",
    },
    {
        buildEntry: openCodeEntry,
        configPath: ({ projectRoot }) => join(projectRoot, "opencode.json"),
        format: "json",
        id: "opencode",
        key: "mcp",
        label: "OpenCode",
        scope: "project",
    },
    {
        buildEntry: clineEntry,
        configPath: ({ projectRoot }) => join(projectRoot, ".cline", "mcp.json"),
        format: "json",
        id: "cline",
        key: "mcpServers",
        label: "Cline",
        scope: "project",
    },
    {
        buildEntry: zedEntry,
        configPath: ({ home }) => join(home, ".config", "zed", "settings.json"),
        format: "json",
        id: "zed",
        key: "context_servers",
        label: "Zed",
        scope: "user",
    },
    {
        configPath: ({ home }) => join(home, ".codex", "config.toml"),
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
export { claudeDesktopEntry, claudeDesktopPath, codexSnippet, findMcpClient, geminiEntry, MCP_CLIENT_IDS, MCP_CLIENTS, standardEntry, windsurfEntry };
