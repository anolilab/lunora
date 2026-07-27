import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora mcp` — connect AI coding agents to Lunora over the Model Context
 * Protocol. `install` writes the server entries into an editor's MCP config;
 * `serve` is the stdio server those entries spawn.
 */
const mcpCommand: Command = {
    argument: { description: "install [client…] | uninstall [client…] | serve", name: "args", type: String },
    description: "Connect your AI editor to Lunora over MCP (docs search + this project's dev server)",
    examples: [
        ["lunora mcp install", "Install into every MCP client already configured here"],
        ["lunora mcp install claude-code cursor", "Install into specific clients"],
        ["lunora mcp install --list", "List the supported clients and their config files"],
        ["lunora mcp install --docs-only", "Install only the hosted documentation server"],
        ["lunora mcp install --print", "Show the config that would be written, without writing it"],
        ["lunora mcp install --global", "Force every server into the machine-wide config"],
        ["lunora mcp uninstall", "Remove Lunora's MCP servers from every supported client"],
        ["lunora mcp uninstall cursor", "Remove them from one client"],
        ["lunora mcp serve", "Run the stdio MCP server (this is what your editor spawns)"],
        ["lunora mcp serve --allow-writes", "Also expose the mutation/action tools"],
    ],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "mcp",
    options: [
        { description: "install: replace entries that already exist", name: "force", type: Boolean },
        { description: "install: list the supported clients and their config files", name: "list", type: Boolean },
        { description: "install: print the config instead of writing it", name: "print", type: Boolean },
        { description: "install/uninstall: only the hosted documentation server", name: "docs-only", type: Boolean },
        { description: "install/uninstall: only this project's local server", name: "local-only", type: Boolean },
        { description: "install: write to the machine-wide config (default: docs server global, local server per-project)", name: "global", type: Boolean },
        { description: "install: write to this project's config instead of the machine-wide one", name: "project", type: Boolean },
        { description: "serve: also expose the mutation/action tools (default: read-only)", name: "allow-writes", type: Boolean },
        { description: "serve: skip the documentation tools", name: "no-docs", type: Boolean },
        { description: "Docs site origin backing the documentation tools (default https://lunora.sh)", name: "docs-url", type: String },
        { description: "serve: deployment URL to expose (default: the running dev server)", name: "url", type: String },
        { description: "serve: bearer token (default: LUNORA_ADMIN_TOKEN from the environment or .dev.vars)", name: "token", type: String },
    ],
};

export { mcpCommand };

export type McpOptions = CreateOptions<{
    "allow-writes": boolean | undefined;
    // `--no-docs` is declared as a `no-*` option but cerebro exposes it at
    // runtime under the negated positive key.
    docs: boolean | undefined;
    "docs-only": boolean | undefined;
    "docs-url": string | undefined;
    force: boolean | undefined;
    global: boolean | undefined;
    list: boolean | undefined;
    "local-only": boolean | undefined;
    print: boolean | undefined;
    project: boolean | undefined;
    token: string | undefined;
    url: string | undefined;
}>;
