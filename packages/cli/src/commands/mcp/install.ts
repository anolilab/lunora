/* eslint-disable unicorn/prevent-abbreviations -- "docs" is public API here: the `lunora-docs` server name, the `--docs-only` / `--docs-url` flags, and the `lunora_*_docs` tools. Renaming these identifiers to "documentation" would diverge from what users type. */

/**
 * `lunora mcp install` — wire Lunora's MCP servers into an editor's config.
 *
 * Two servers get installed:
 *
 * - `lunora-docs` — the hosted documentation server. No credentials, no project
 * needed, useful in any repository that talks to Lunora.
 * - `lunora` — this project's local server (`lunora mcp serve`), which adds the
 * dev-server tools and typed access to the app's own functions. Only installed
 * inside a Lunora project, since it has nothing to point at otherwise.
 *
 * The command's whole job is knowing each client's file, key, and entry shape
 * (see `../../util/mcp-clients`) so the user doesn't have to.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { findWranglerFile } from "@lunora/config";
import { join, relative } from "@visulima/path";

import type { PackageManager } from "../../util/detect-package-manager";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import type { JsonMcpClient, McpClient, McpServerSpec } from "../../util/mcp-clients";
import { findMcpClient, MCP_CLIENT_IDS, MCP_CLIENTS } from "../../util/mcp-clients";
import type { UpsertAction } from "../../util/mcp-config-file";
import { upsertMcpEntry } from "../../util/mcp-config-file";

/** The hosted documentation MCP endpoint. */
const DEFAULT_DOCS_MCP_URL = "https://lunora.sh/mcp";

/** Server names written into each client's config. */
const DOCS_SERVER_NAME = "lunora-docs";
const LOCAL_SERVER_NAME = "lunora";

interface McpInstallOptions {
    /** Client ids to install into; empty means "every client with a config already present". */
    clients: ReadonlyArray<string>;
    cwd: string;
    /** Install only the hosted docs server. */
    docsOnly?: boolean;
    /** Hosted docs MCP URL override (e.g. a self-hosted docs site). */
    docsUrl?: string;
    /** Replace entries that already exist. */
    force?: boolean;
    /** Home directory; injectable for tests. */
    home?: string;
    /** Install only this project's local server. */
    localOnly?: boolean;
    logger: Logger;
    /** `process.platform`; injectable for tests. */
    platform?: NodeJS.Platform;
    /** Print what would be written without touching any file. */
    print?: boolean;
}

interface McpInstallResult {
    code: number;
    /** One entry per (client, server) pair acted on — the assertion surface for tests. */
    written: ReadonlyArray<{ action: UpsertAction | "printed"; client: string; path: string; server: string }>;
}

/** True when `cwd` looks like a Lunora project — the same check `lunora add` makes. */
const isLunoraProject = (cwd: string): boolean => existsSync(join(cwd, "lunora")) && findWranglerFile(cwd) !== undefined;

/**
 * How a client should spawn the local server.
 *
 * Routed through the project's package manager (`pnpm exec lunora …`) rather
 * than a bare `lunora`, because the CLI is normally a project dependency and
 * `node_modules/.bin` is not on the PATH of a process an editor spawns.
 */
const localServerSpec = (manager: PackageManager): McpServerSpec => {
    const { args, command } = execArgsFor(manager, "lunora", ["mcp", "serve"]);

    return { args, command, transport: "stdio" };
};

const docsServerSpec = (url: string): McpServerSpec => {
    return { transport: "http", url };
};

/** Clients whose config file already exists — the ones the user demonstrably uses. */
const detectInstalledClients = (context: { home: string; platform: NodeJS.Platform; projectRoot: string }): ReadonlyArray<McpClient> =>
    MCP_CLIENTS.filter((client) => {
        if (client.format !== "json") {
            return false;
        }

        const path = client.configPath(context);

        return path !== undefined && existsSync(path);
    });

/** A path relative to the project when it sits inside it, else the absolute path. */
const displayPath = (path: string, projectRoot: string): string => {
    const relativePath = relative(projectRoot, path);

    return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : path;
};

/** Write (or print) one server entry into one JSON client, reporting what happened. */
const installIntoJsonClient = (
    client: JsonMcpClient,
    server: { name: string; spec: McpServerSpec },
    options: McpInstallOptions & { home: string; platform: NodeJS.Platform },
): { action: UpsertAction | "printed"; path: string } | undefined => {
    const path = client.configPath({ home: options.home, platform: options.platform, projectRoot: options.cwd });

    if (path === undefined) {
        options.logger.warn(`${client.label}: no known config location on ${options.platform} — skipped.`);

        return undefined;
    }

    const entry = client.buildEntry(server.spec);

    if (entry === undefined) {
        options.logger.warn(`${client.label}: cannot express a ${server.spec.transport} server — skipped.`);

        return undefined;
    }

    if (options.print === true) {
        options.logger.info(`${client.label} → ${displayPath(path, options.cwd)}\n${JSON.stringify({ [client.key]: { [server.name]: entry } }, undefined, 4)}`);

        return { action: "printed", path };
    }

    const result = upsertMcpEntry({ entry, force: options.force === true, key: client.key, name: server.name, path });
    const shown = displayPath(path, options.cwd);

    if (result.action === "invalid") {
        options.logger.error(`${client.label}: ${shown} is not valid JSON (${result.error ?? "unknown error"}) — left untouched.`);
    } else if (result.action === "skipped") {
        options.logger.info(`${client.label}: "${server.name}" already configured in ${shown} — re-run with --force to replace it.`);
    } else {
        options.logger.success(`${client.label}: ${result.action === "created" ? "created" : "updated"} ${shown} with "${server.name}".`);
    }

    return { action: result.action, path };
};

/** Print the paste-in snippet for a client whose config we don't rewrite. */
const installIntoManualClient = (
    client: Extract<McpClient, { format: "manual" }>,
    server: { name: string; spec: McpServerSpec },
    options: McpInstallOptions,
): { action: "printed"; path: string } => {
    options.logger.info(`${client.label}: add this to ${client.configHint}\n\n${client.renderSnippet(server.name, server.spec)}`);

    return { action: "printed", path: client.configHint };
};

/** Resolve which clients to act on, or `undefined` after reporting why none could be. */
const resolveClients = (options: McpInstallOptions, context: { home: string; platform: NodeJS.Platform }): ReadonlyArray<McpClient> | undefined => {
    if (options.clients.length > 0) {
        const resolved: McpClient[] = [];

        for (const id of options.clients) {
            const client = findMcpClient(id);

            if (client === undefined) {
                options.logger.error(`mcp install: unknown client "${id}". Known clients: ${MCP_CLIENT_IDS.join(", ")}.`);

                return undefined;
            }

            resolved.push(client);
        }

        return resolved;
    }

    const detected = detectInstalledClients({ ...context, projectRoot: options.cwd });

    if (detected.length > 0) {
        options.logger.info(`Detected ${String(detected.length)} configured client(s): ${detected.map((client) => client.label).join(", ")}.`);

        return detected;
    }

    options.logger.error(
        `mcp install: no MCP client config found — name one explicitly, e.g. \`lunora mcp install claude-code\`. Known clients: ${MCP_CLIENT_IDS.join(", ")}.`,
    );

    return undefined;
};

/** Which servers to install, given the flags and whether `cwd` is a Lunora project. */
const resolveServers = (options: McpInstallOptions): ReadonlyArray<{ name: string; spec: McpServerSpec }> => {
    const servers: { name: string; spec: McpServerSpec }[] = [];

    if (options.localOnly !== true) {
        servers.push({ name: DOCS_SERVER_NAME, spec: docsServerSpec(options.docsUrl ?? DEFAULT_DOCS_MCP_URL) });
    }

    if (options.docsOnly !== true && isLunoraProject(options.cwd)) {
        servers.push({ name: LOCAL_SERVER_NAME, spec: localServerSpec(detectPackageManager(options.cwd)) });
    }

    return servers;
};

/** `lunora mcp install --list` — the table of supported clients and their config files. */
const runMcpInstallList = (options: Pick<McpInstallOptions, "cwd" | "logger"> & { home?: string; platform?: NodeJS.Platform }): McpInstallResult => {
    const home = options.home ?? homedir();
    const platform = options.platform ?? process.platform;

    options.logger.info("Supported MCP clients:");

    for (const client of MCP_CLIENTS) {
        const path =
            client.format === "json"
                ? (client.configPath({ home, platform, projectRoot: options.cwd }) ?? "(unsupported on this platform)")
                : client.configHint;

        options.logger.info(`  ${client.id.padEnd(15)} ${client.label.padEnd(24)} ${displayPath(path, options.cwd)}`);
    }

    return { code: 0, written: [] };
};

/** `lunora mcp install [client…]`. */
const runMcpInstall = (options: McpInstallOptions): McpInstallResult => {
    const home = options.home ?? homedir();
    const platform = options.platform ?? process.platform;
    const clients = resolveClients(options, { home, platform });

    if (clients === undefined) {
        return { code: 1, written: [] };
    }

    const servers = resolveServers(options);

    if (servers.length === 0) {
        options.logger.error("mcp install: nothing to install — `--local-only` was set but this directory is not a Lunora project.");

        return { code: 1, written: [] };
    }

    const written: { action: UpsertAction | "printed"; client: string; path: string; server: string }[] = [];

    for (const client of clients) {
        for (const server of servers) {
            const result =
                client.format === "json"
                    ? installIntoJsonClient(client, server, { ...options, home, platform })
                    : installIntoManualClient(client, server, options);

            if (result !== undefined) {
                written.push({ action: result.action, client: client.id, path: result.path, server: server.name });
            }
        }
    }

    if (written.some((entry) => entry.action === "created" || entry.action === "updated")) {
        options.logger.info("Restart your editor (or reload its MCP servers) to pick up the change.");
    }

    // A config we refused to touch is a real failure the user has to resolve;
    // an already-present entry is not.
    return { code: written.some((entry) => entry.action === "invalid") ? 1 : 0, written };
};

export type { McpInstallOptions, McpInstallResult };
export { DEFAULT_DOCS_MCP_URL, detectInstalledClients, DOCS_SERVER_NAME, isLunoraProject, LOCAL_SERVER_NAME, runMcpInstall, runMcpInstallList };
