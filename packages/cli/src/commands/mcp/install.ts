/* eslint-disable unicorn/prevent-abbreviations -- "docs" is public API here: the `lunora-docs` server name, the `--docs-only` / `--docs-url` flags, and the `lunora_*_docs` tools. Renaming these identifiers to "documentation" would diverge from what users type. */

/**
 * `lunora mcp install` — wire Lunora's MCP servers into an editor's config.
 *
 * The command's whole job is knowing each client's file, key and entry shape
 * (see `../../util/mcp-clients`) so the user doesn't have to; the traversal it
 * shares with `uninstall` lives in `../../util/mcp-targets`.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { findWranglerFile } from "@lunora/config";
import { join } from "@visulima/path";

import type { PackageManager } from "../../util/detect-package-manager";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import type { JsonMcpClient, ManualMcpClient, McpClient, McpPathContext, McpScope, McpServerSpec } from "../../util/mcp-clients";
import { MCP_CLIENT_IDS, MCP_CLIENTS } from "../../util/mcp-clients";
import type { UpsertAction } from "../../util/mcp-config-file";
import { hasMcpEntry, upsertMcpEntry } from "../../util/mcp-config-file";
import { detectInstalledClients, displayPath, preferredTarget, resolveClients } from "../../util/mcp-targets";

/** The hosted documentation MCP endpoint. */
const DEFAULT_DOCS_MCP_URL = "https://lunora.sh/mcp";

/** Server names written into each client's config. */
const DOCS_SERVER_NAME = "lunora-docs";
const LOCAL_SERVER_NAME = "lunora";

/** A server to install, and which of a client's config files it belongs in. */
interface McpServerPlan {
    /**
     * Whether this server may be written to the client's other scope when its
     * preferred one is absent.
     *
     * True for the docs server: it is the same hosted URL everywhere, so a
     * client with only a global config still gets something correct. False for
     * the local server: it is defined by the project it runs in, the stdio spec
     * carries no `cwd`, and a machine-wide `lunora` entry would serve whichever
     * directory the editor started in — then silently report "already
     * configured" for every other project.
     */
    allowScopeFallback: boolean;
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

/** The inputs a client's paths depend on, drawn from this command's options. */
const pathContext = (options: McpInstallOptions & { home: string; platform: NodeJS.Platform }): McpPathContext => {
    return { home: options.home, platform: options.platform, projectRoot: options.cwd };
};

/** The config file a server should be written to, honouring an explicit `--global`/`--project`. */
const targetFor = (client: McpClient, server: McpServerPlan, options: McpInstallOptions & { home: string; platform: NodeJS.Platform }) =>
    preferredTarget(client, pathContext(options), options.scope ?? server.preferredScope, options.scope !== undefined || !server.allowScopeFallback);

/** Write (or print) one server entry into one JSON client, reporting what happened. */
const installIntoJsonClient = (
    client: JsonMcpClient,
    server: McpServerPlan,
    options: McpInstallOptions & { home: string; platform: NodeJS.Platform },
): { action: UpsertAction | "printed"; path: string } | undefined => {
    const target = targetFor(client, server, options);

    if (target === undefined) {
        options.logger.warn(`${client.label}: has no ${options.scope ?? server.preferredScope}-scoped config — skipped "${server.name}".`);

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
    const path = targetFor(client, server, options)?.path;

    if (path === undefined) {
        options.logger.warn(`${client.label}: no known config location on ${options.platform} — skipped.`);

        return undefined;
    }

    options.logger.info(`${client.label}: add this to ${displayPath(path, options.cwd)}\n\n${client.renderSnippet(server.name, server.spec)}`);

    return { action: "printed", path };
};

/**
 * Which servers to install, given the flags and whether `cwd` is a Lunora
 * project. Returns empty when the flags select nothing — {@link runMcpInstall}
 * turns that into the message explaining which flag is responsible.
 */
const resolveServers = (options: McpInstallOptions): ReadonlyArray<McpServerPlan> => {
    const servers: McpServerPlan[] = [];

    if (options.localOnly !== true) {
        servers.push({
            allowScopeFallback: true,
            name: DOCS_SERVER_NAME,
            preferredScope: "global",
            spec: docsServerSpec(options.docsUrl ?? DEFAULT_DOCS_MCP_URL),
        });
    }

    if (options.docsOnly !== true && isLunoraProject(options.cwd)) {
        servers.push({
            allowScopeFallback: false,
            name: LOCAL_SERVER_NAME,
            preferredScope: "project",
            spec: localServerSpec(detectPackageManager(options.cwd)),
        });
    }

    return servers;
};

/** `lunora mcp install --list` — the table of supported clients and their config files. */
const runMcpInstallList = (options: Pick<McpInstallOptions, "cwd" | "logger"> & { home?: string; platform?: NodeJS.Platform }): McpInstallResult => {
    const home = options.home ?? homedir();
    const platform = options.platform ?? process.platform;

    options.logger.info("Supported MCP clients:");

    for (const client of MCP_CLIENTS) {
        const paths = client.paths({ home, platform, projectRoot: options.cwd });
        const show = (scope: McpScope): string => {
            const path = paths[scope];

            return path === undefined ? "—" : displayPath(path, options.cwd);
        };

        options.logger.info(`  ${client.id.padEnd(15)} ${client.label.padEnd(24)} project: ${show("project").padEnd(30)} global: ${show("global")}`);
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
    const clients = resolveClients(options.clients, () => detectInstalledClients({ home, platform, projectRoot: options.cwd }), options.logger, "install");

    if (clients === undefined) {
        return { code: 1, written: [] };
    }

    if (clients.length === 0) {
        // Detection found nothing, so there is no sensible default. Naming a
        // client is better than silently doing nothing and exiting 0.
        options.logger.error(
            `mcp install: no MCP client config found — name one explicitly, e.g. \`lunora mcp install claude-code\`. Known clients: ${MCP_CLIENT_IDS.join(", ")}.`,
        );

        return { code: 1, written: [] };
    }

    if (options.clients.length === 0) {
        options.logger.info(`Detected ${String(clients.length)} configured client(s): ${clients.map((client) => client.label).join(", ")}.`);
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

export type { McpInstallOptions, McpInstallResult, McpServerPlan };
export { DEFAULT_DOCS_MCP_URL, DOCS_SERVER_NAME, LOCAL_SERVER_NAME, runMcpInstall, runMcpInstallList };
