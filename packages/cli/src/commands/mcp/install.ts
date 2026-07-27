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
import type { JsonMcpClient, ManualMcpClient, McpClient, McpScope, McpServerSpec } from "../../util/mcp-clients";
import { findMcpClient, MCP_CLIENT_IDS, MCP_CLIENTS } from "../../util/mcp-clients";
import type { UpsertAction } from "../../util/mcp-config-file";
import { hasMcpEntry, upsertMcpEntry } from "../../util/mcp-config-file";

/** The hosted documentation MCP endpoint. */
const DEFAULT_DOCS_MCP_URL = "https://lunora.sh/mcp";

/** Server names written into each client's config. */
const DOCS_SERVER_NAME = "lunora-docs";
const LOCAL_SERVER_NAME = "lunora";

/** A server to install, and which of a client's config files it belongs in. */
interface McpServerPlan {
    name: string;

    /**
     * Where this server wants to live when the user hasn't said. The docs server
     * is the same hosted URL in every project, so it belongs in the global
     * config; the local server only means anything inside this project.
     */
    preferredScope: McpScope;
    spec: McpServerSpec;
}

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
    /** Force every server into one scope, overriding its {@link McpServerPlan.preferredScope}. */
    scope?: McpScope;
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
    MCP_CLIENTS.filter((client) =>
        // Configured in EITHER scope counts as "the user uses this client".
        (["global", "project"] as const).some((scope) => {
            const path = client.configPath({ ...context, scope });

            return path !== undefined && existsSync(path);
        }),
    );

/**
 * The config file this server should go in for this client, and the scope that
 * resolved to.
 *
 * Falls back to the other scope when the preferred one has no file — Zed has no
 * project config, VS Code no global one — so "install the docs server into
 * every detected client" still does something sensible everywhere rather than
 * skipping half the list.
 */
const resolveTarget = (
    client: McpClient,
    server: McpServerPlan,
    options: McpInstallOptions & { home: string; platform: NodeJS.Platform },
): { path: string; scope: McpScope } | undefined => {
    const wanted = options.scope ?? server.preferredScope;
    const order: McpScope[] = wanted === "global" ? ["global", "project"] : ["project", "global"];

    for (const scope of options.scope === undefined ? order : [wanted]) {
        const path = client.configPath({ home: options.home, platform: options.platform, projectRoot: options.cwd, scope });

        if (path !== undefined) {
            return { path, scope };
        }
    }

    return undefined;
};

/** A path relative to the project when it sits inside it, else the absolute path. */
const displayPath = (path: string, projectRoot: string): string => {
    const relativePath = relative(projectRoot, path);

    return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : path;
};

/** Write (or print) one server entry into one JSON client, reporting what happened. */
const installIntoJsonClient = (
    client: JsonMcpClient,
    server: McpServerPlan,
    options: McpInstallOptions & { home: string; platform: NodeJS.Platform },
): { action: UpsertAction | "printed"; path: string } | undefined => {
    const target = resolveTarget(client, server, options);

    if (target === undefined) {
        options.logger.warn(`${client.label}: no ${options.scope ?? server.preferredScope} config location known on ${options.platform} — skipped.`);

        return undefined;
    }

    const { path } = target;

    const entry = client.buildEntry(server.spec);

    if (options.print === true) {
        const shown = displayPath(path, options.cwd);

        // Preview what a real run would do, not just what it would write: the
        // write path skips an entry that already exists unless `--force`, so
        // printing it unconditionally promises a change that won't happen.
        if (options.force !== true && hasMcpEntry({ key: client.key, name: server.name, path })) {
            options.logger.info(
                `${client.label}: "${server.name}" already configured in ${shown} — a real install would skip it (re-run with --force to replace).`,
            );

            return { action: "printed", path };
        }

        options.logger.info(`${client.label} → ${shown}\n${JSON.stringify({ [client.key]: { [server.name]: entry } }, undefined, 4)}`);

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
    client: ManualMcpClient,
    server: McpServerPlan,
    options: McpInstallOptions & { home: string; platform: NodeJS.Platform },
): { action: "printed"; path: string } | undefined => {
    const path = resolveTarget(client, server, options)?.path;

    if (path === undefined) {
        options.logger.warn(`${client.label}: no known config location on ${options.platform} — skipped.`);

        return undefined;
    }

    options.logger.info(`${client.label}: add this to ${displayPath(path, options.cwd)}\n\n${client.renderSnippet(server.name, server.spec)}`);

    return { action: "printed", path };
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

/**
 * Which servers to install, given the flags and whether `cwd` is a Lunora
 * project. Returns empty when the flags select nothing — {@link runMcpInstall}
 * turns that into the message explaining which flag is responsible.
 */
const resolveServers = (options: McpInstallOptions): ReadonlyArray<McpServerPlan> => {
    const servers: McpServerPlan[] = [];

    if (options.localOnly !== true) {
        servers.push({ name: DOCS_SERVER_NAME, preferredScope: "global", spec: docsServerSpec(options.docsUrl ?? DEFAULT_DOCS_MCP_URL) });
    }

    if (options.docsOnly !== true && isLunoraProject(options.cwd)) {
        servers.push({ name: LOCAL_SERVER_NAME, preferredScope: "project", spec: localServerSpec(detectPackageManager(options.cwd)) });
    }

    return servers;
};

/** `lunora mcp install --list` — the table of supported clients and their config files. */
const runMcpInstallList = (options: Pick<McpInstallOptions, "cwd" | "logger"> & { home?: string; platform?: NodeJS.Platform }): McpInstallResult => {
    const home = options.home ?? homedir();
    const platform = options.platform ?? process.platform;

    options.logger.info("Supported MCP clients:");

    for (const client of MCP_CLIENTS) {
        const forScope = (scope: McpScope): string => {
            const path = client.configPath({ home, platform, projectRoot: options.cwd, scope });

            return path === undefined ? "—" : displayPath(path, options.cwd);
        };

        options.logger.info(`  ${client.id.padEnd(15)} ${client.label.padEnd(24)} project: ${forScope("project").padEnd(30)} global: ${forScope("global")}`);
    }

    return { code: 0, written: [] };
};

/** Why the flags selected no server at all — named precisely, so the user fixes the right thing. */
const describeEmptySelection = (options: McpInstallOptions): string => {
    if (options.docsOnly === true && options.localOnly === true) {
        return "`--docs-only` and `--local-only` are mutually exclusive — pass at most one.";
    }

    return "`--local-only` was set but this directory is not a Lunora project (no `lunora/` directory and wrangler config).";
};

/** Install every server into every client, collecting what happened to each pair. */
const installAll = (
    clients: ReadonlyArray<McpClient>,
    servers: ReadonlyArray<McpServerPlan>,
    options: McpInstallOptions & { home: string; platform: NodeJS.Platform },
): McpInstallResult["written"] => {
    const written: { action: UpsertAction | "printed"; client: string; path: string; server: string }[] = [];

    for (const client of clients) {
        for (const server of servers) {
            const result = client.format === "json" ? installIntoJsonClient(client, server, options) : installIntoManualClient(client, server, options);

            if (result !== undefined) {
                written.push({ action: result.action, client: client.id, path: result.path, server: server.name });
            }
        }
    }

    return written;
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
        options.logger.error(`mcp install: nothing to install — ${describeEmptySelection(options)}`);

        return { code: 1, written: [] };
    }

    const written = installAll(clients, servers, { ...options, home, platform });

    if (written.some((entry) => entry.action === "created" || entry.action === "updated")) {
        options.logger.info("Restart your editor (or reload its MCP servers) to pick up the change.");
    }

    // A config we refused to touch is a real failure the user has to resolve;
    // an already-present entry is not.
    return { code: written.some((entry) => entry.action === "invalid") ? 1 : 0, written };
};

export type { McpInstallOptions, McpInstallResult };
export { DEFAULT_DOCS_MCP_URL, detectInstalledClients, DOCS_SERVER_NAME, isLunoraProject, LOCAL_SERVER_NAME, resolveTarget, runMcpInstall, runMcpInstallList };
