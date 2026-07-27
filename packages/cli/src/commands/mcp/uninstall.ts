/**
 * `lunora mcp uninstall` — take Lunora's MCP servers back out of an editor's
 * config.
 *
 * The counterpart to `install`, and the reason `install` is safe to try. It
 * removes only the two entries we write (`lunora-docs`, `lunora`), from both
 * scopes, leaving every other server the user has configured — and the file's
 * comments and formatting — alone.
 */
import { homedir } from "node:os";

import { relative } from "@visulima/path";

import type { Logger } from "../../util/logger";
import type { McpClient, McpScope } from "../../util/mcp-clients";
import { findMcpClient, MCP_CLIENT_IDS, MCP_CLIENTS } from "../../util/mcp-clients";
import type { RemoveAction } from "../../util/mcp-config-file";
import { removeMcpEntry } from "../../util/mcp-config-file";
import { DOCS_SERVER_NAME, LOCAL_SERVER_NAME } from "./install";

interface McpUninstallOptions {
    /** Client ids to clean; empty means every supported client. */
    clients: ReadonlyArray<string>;
    cwd: string;
    /** Remove only the hosted docs server. */
    docsOnly?: boolean;
    home?: string;
    /** Remove only this project's local server. */
    localOnly?: boolean;
    logger: Logger;
    platform?: NodeJS.Platform;
}

interface McpUninstallResult {
    code: number;
    removed: ReadonlyArray<{ action: RemoveAction; client: string; path: string; server: string }>;
}

/** Both scopes, because `install` may have written to either. */
const SCOPES: ReadonlyArray<McpScope> = ["project", "global"];

const displayPath = (path: string, projectRoot: string): string => {
    const relativePath = relative(projectRoot, path);

    return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : path;
};

/** Server names to remove, given the flags. */
const targetServers = (options: McpUninstallOptions): ReadonlyArray<string> => {
    const names: string[] = [];

    if (options.localOnly !== true) {
        names.push(DOCS_SERVER_NAME);
    }

    if (options.docsOnly !== true) {
        names.push(LOCAL_SERVER_NAME);
    }

    return names;
};

/** Resolve the clients to clean, or `undefined` after reporting an unknown id. */
const resolveClients = (options: McpUninstallOptions): ReadonlyArray<McpClient> | undefined => {
    if (options.clients.length === 0) {
        // Unlike `install`, the default is EVERY client: the user is trying to
        // get rid of these, and a leftover entry in a client we didn't think to
        // check is exactly the failure they'd notice later.
        return MCP_CLIENTS;
    }

    const resolved: McpClient[] = [];

    for (const id of options.clients) {
        const client = findMcpClient(id);

        if (client === undefined) {
            options.logger.error(`mcp uninstall: unknown client "${id}". Known clients: ${MCP_CLIENT_IDS.join(", ")}.`);

            return undefined;
        }

        resolved.push(client);
    }

    return resolved;
};

/** Remove one server from one config file, reporting what happened. */
const removeOne = (
    client: Extract<McpClient, { format: "json" }>,
    server: string,
    path: string,
    options: McpUninstallOptions,
): { action: RemoveAction; path: string } => {
    const result = removeMcpEntry({ key: client.key, name: server, path });
    const shown = displayPath(path, options.cwd);

    if (result.action === "removed") {
        options.logger.success(`${client.label}: removed "${server}" from ${shown}.`);
    } else if (result.action === "invalid") {
        options.logger.error(`${client.label}: ${shown} is not valid JSON (${result.error ?? "unknown error"}) — left untouched.`);
    }

    return { action: result.action, path };
};

/** `lunora mcp uninstall [client…]`. */
const runMcpUninstall = (options: McpUninstallOptions): McpUninstallResult => {
    const home = options.home ?? homedir();
    const platform = options.platform ?? process.platform;
    const clients = resolveClients(options);

    if (clients === undefined) {
        return { code: 1, removed: [] };
    }

    const servers = targetServers(options);
    const removed: { action: RemoveAction; client: string; path: string; server: string }[] = [];

    // Manual (TOML) clients were never written to, so there is nothing to undo.
    const writable = clients.filter((client): client is Extract<McpClient, { format: "json" }> => client.format === "json");

    for (const client of writable) {
        for (const scope of SCOPES) {
            const path = client.configPath({ home, platform, projectRoot: options.cwd, scope });

            if (path === undefined) {
                continue;
            }

            for (const server of servers) {
                removed.push({ ...removeOne(client, server, path, options), client: client.id, server });
            }
        }
    }

    if (!removed.some((entry) => entry.action === "removed")) {
        options.logger.info("Nothing to remove — no Lunora MCP servers were configured in the clients checked.");
    }

    return { code: removed.some((entry) => entry.action === "invalid") ? 1 : 0, removed };
};

export type { McpUninstallOptions, McpUninstallResult };
export { runMcpUninstall };
