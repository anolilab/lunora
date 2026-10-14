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
 * **Rule for adding a client: verify its remote shape against that vendor's own
 * docs.** Getting one wrong is the worst failure this command has — the config
 * lands, we report success, and the server silently never connects. The list was
 * widened using [`add-mcp`](https://www.npmjs.com/package/add-mcp) (Apache-2.0)
 * as a starting point, but two of its shapes are wrong (`{type, url}` for
 * Gemini, `source: "custom"` for Zed), so it is a lead, not a source of truth.
 * Each builder below records what its own vendor documents.
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

/**
 * Which of a client's two config files to target.
 *
 * The distinction matters because the two servers want different homes: the
 * hosted docs server is the same URL in every project and belongs in the global
 * config, while this project's local server only means anything inside it.
 */
type McpScope = "global" | "project";

/** Inputs a client's config paths depend on. */
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
     * The config files this client has, keyed by scope. A scope is absent when
     * the client has no such file, or when we don't know the convention on this
     * platform — left out rather than guessed, because a plausible-looking wrong
     * path is one that gets written to.
     *
     * Manual (TOML) clients declare theirs too: "is this client set up here?" is
     * the same question regardless of the file's format.
     */
    paths: (context: McpPathContext) => Partial<Record<McpScope, string>>;
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
 * Not the universal shape it looks like — see the builders below.
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
 * Zed keys its servers under `context_servers`, and distinguishes them purely by
 * shape: a `url` is remote, a `command` is local. No discriminator field.
 */
const zedEntry = (spec: McpServerSpec): Record<string, unknown> => (spec.transport === "http" ? { url: spec.url } : stdioEntry(spec));

/**
 * OpenCode discriminates on an explicit `type`, and takes the whole command line
 * as one array rather than `command` + `args`.
 */
const openCodeEntry = (spec: McpServerSpec): Record<string, unknown> =>
    spec.transport === "http"
        ? { enabled: true, type: "remote", url: spec.url }
        : { command: [spec.command, ...spec.args], enabled: true, type: "local", ...(spec.env === undefined ? {} : { environment: spec.env }) };

/** Cline spells Streamable HTTP `streamableHttp` and carries an explicit `disabled` flag. */
const clineEntry = (spec: McpServerSpec): Record<string, unknown> =>
    spec.transport === "http" ? { disabled: false, type: "streamableHttp", url: spec.url } : { disabled: false, ...stdioEntry(spec) };

/**
 * Claude Desktop stores its config under the OS application-data directory,
 * which differs per platform. Returns no path where we don't know the
 * convention, rather than a plausible-looking wrong one to write to.
 */
const claudeDesktopPaths = ({ home, platform }: McpPathContext): Partial<Record<McpScope, string>> => {
    // Claude Desktop has no project-level config at all.
    if (platform === "darwin") {
        return { global: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json") };
    }

    if (platform === "win32") {
        const appData = process.env["APPDATA"];

        return appData === undefined || appData === "" ? {} : { global: join(appData, "Claude", "claude_desktop_config.json") };
    }

    if (platform === "linux") {
        return { global: join(home, ".config", "Claude", "claude_desktop_config.json") };
    }

    return {};
};

/**
 * Render the `[mcp_servers.<name>]` table Codex reads.
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
 * The supported clients, in the order `lunora mcp install --list` prints them.
 *
 * Codex is `manual` because its config is TOML: merging into it would mean
 * carrying a TOML parser that preserves formatting, and a bad merge silently
 * corrupts a file we don't own. Printing the snippet is the honest trade.
 */
const MCP_CLIENTS: ReadonlyArray<McpClient> = [
    {
        buildEntry: standardEntry,
        // Project-only on purpose. Claude Code's user-scoped servers live in
        // `~/.claude.json`, but that file is its entire application state —
        // projects, history, account — and it rewrites it continuously while
        // running, so our read-modify-write would drop whatever it wrote in
        // between. `claude mcp add -s user` is the safe way to reach that file.
        paths: ({ projectRoot }: McpPathContext): Partial<Record<McpScope, string>> => {
            return { project: join(projectRoot, ".mcp.json") };
        },
        format: "json",
        id: "claude-code",
        key: "mcpServers",
        label: "Claude Code",
    },
    {
        buildEntry: standardEntry,
        paths: ({ home, projectRoot }: McpPathContext): Partial<Record<McpScope, string>> => {
            return { global: join(home, ".cursor", "mcp.json"), project: join(projectRoot, ".cursor", "mcp.json") };
        },
        format: "json",
        id: "cursor",
        key: "mcpServers",
        label: "Cursor",
    },
    {
        buildEntry: standardEntry,
        // Project-only: VS Code keeps user-level MCP config inside its per-OS
        // user-settings directory, which we do not resolve confidently.
        // No global entry: VS Code keeps user-level MCP config inside its per-OS
        // user-settings directory, which we do not resolve confidently.
        paths: ({ projectRoot }: McpPathContext): Partial<Record<McpScope, string>> => {
            return { project: join(projectRoot, ".vscode", "mcp.json") };
        },
        format: "json",
        id: "vscode",
        // VS Code is the odd one out: `servers`, not `mcpServers`.
        key: "servers",
        label: "VS Code (GitHub Copilot)",
    },
    {
        buildEntry: geminiEntry,
        paths: ({ home, projectRoot }: McpPathContext): Partial<Record<McpScope, string>> => {
            return { global: join(home, ".gemini", "settings.json"), project: join(projectRoot, ".gemini", "settings.json") };
        },
        format: "json",
        id: "gemini",
        key: "mcpServers",
        label: "Gemini CLI",
    },
    {
        buildEntry: claudeDesktopEntry,
        paths: claudeDesktopPaths,
        format: "json",
        id: "claude-desktop",
        key: "mcpServers",
        label: "Claude Desktop",
    },
    {
        buildEntry: windsurfEntry,
        paths: ({ home }: McpPathContext): Partial<Record<McpScope, string>> => {
            return { global: join(home, ".codeium", "windsurf", "mcp_config.json") };
        },
        format: "json",
        id: "windsurf",
        key: "mcpServers",
        label: "Windsurf",
    },
    {
        buildEntry: openCodeEntry,
        paths: ({ home, projectRoot }: McpPathContext): Partial<Record<McpScope, string>> => {
            return { global: join(home, ".config", "opencode", "opencode.json"), project: join(projectRoot, "opencode.json") };
        },
        format: "json",
        id: "opencode",
        key: "mcp",
        label: "OpenCode",
    },
    {
        buildEntry: clineEntry,
        // Global-only: Cline documents `~/.cline/mcp.json`; the IDE extension
        // stores its own copy where we cannot resolve it.
        // Cline documents `~/.cline/mcp.json`; the IDE extension keeps its own
        // copy where we cannot resolve it.
        paths: ({ home }: McpPathContext): Partial<Record<McpScope, string>> => {
            return { global: join(home, ".cline", "mcp.json") };
        },
        format: "json",
        id: "cline",
        key: "mcpServers",
        label: "Cline",
    },
    {
        buildEntry: zedEntry,
        paths: ({ home }: McpPathContext): Partial<Record<McpScope, string>> => {
            return { global: join(home, ".config", "zed", "settings.json") };
        },
        format: "json",
        id: "zed",
        key: "context_servers",
        label: "Zed",
    },
    {
        paths: ({ home, projectRoot }: McpPathContext): Partial<Record<McpScope, string>> => {
            return { global: join(home, ".codex", "config.toml"), project: join(projectRoot, ".codex", "config.toml") };
        },
        format: "manual",
        id: "codex",
        label: "Codex CLI",
        renderSnippet: codexSnippet,
    },
];

const MCP_CLIENT_IDS: ReadonlyArray<string> = MCP_CLIENTS.map((client) => client.id);

const findMcpClient = (id: string): McpClient | undefined => MCP_CLIENTS.find((client) => client.id === id.toLowerCase());

export type { JsonMcpClient, ManualMcpClient, McpClient, McpPathContext, McpScope, McpServerSpec };
export { claudeDesktopPaths, findMcpClient, MCP_CLIENT_IDS, MCP_CLIENTS };
