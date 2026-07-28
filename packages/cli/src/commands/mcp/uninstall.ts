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

import type { Logger } from "../../util/logger";
import type { JsonMcpClient, McpClient, McpPathContext, McpScope } from "../../util/mcp-clients";
import { MCP_CLIENTS } from "../../util/mcp-clients";
import type { RemoveAction } from "../../util/mcp-config-file";
import { inspectMcpEntry, removeMcpEntry } from "../../util/mcp-config-file";
import type { JsonMcpTarget } from "../../util/mcp-targets";
import { displayPath, isJsonTarget, resolveClients, targetsFor } from "../../util/mcp-targets";
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
    /** Report what would be removed without touching any file. */
    print?: boolean;
    /** Restrict to one scope; default is both, since `install` may have used either. */
    scope?: McpScope;
}

interface McpUninstallResult {
    code: number;
    removed: ReadonlyArray<{ action: RemoveAction; client: string; path: string; server: string }>;
}

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

/** Remove one server from one config file, reporting what happened. */
const removeOne = (client: JsonMcpClient, server: string, path: string, options: McpUninstallOptions): { action: RemoveAction; path: string } => {
    const result = removeMcpEntry({ key: client.key, name: server, path });
    const shown = displayPath(path, options.cwd);

    if (result.action === "removed") {
        options.logger.success(`${client.label}: removed "${server}" from ${shown}.`);
    } else if (result.action === "invalid") {
        options.logger.error(`${client.label}: ${shown} is not valid JSON (${result.error ?? "unknown error"}) — left untouched.`);
    }

    return { action: result.action, path };
};

/**
 * Report what a real run would remove, without touching the file.
 *
 * The command with the widest blast radius in the CLI is the one you most want
 * to rehearse — `install` has `--print`, and this needs it more.
 */
const previewOne = (client: JsonMcpClient, server: string, path: string, options: McpUninstallOptions): { action: RemoveAction; path: string } => {
    const found = inspectMcpEntry({ key: client.key, name: server, path });
    const shown = displayPath(path, options.cwd);

    if (found === "invalid") {
        // Surface it here or the rehearsal is a lie: a real run reports this
        // file, logs an error and exits 1.
        options.logger.error(`${client.label}: ${shown} is not valid JSON — a real run would report it and exit non-zero.`);

        return { action: "invalid", path };
    }

    if (found === "absent") {
        return { action: "absent", path };
    }

    options.logger.info(`${client.label}: would remove "${server}" from ${shown}.`);

    return { action: "removed", path };
};

/** The config files a run will touch, honouring `--global`/`--project`. */
const resolveTargets = (clients: ReadonlyArray<McpClient>, context: McpPathContext, scope: McpScope | undefined): ReadonlyArray<JsonMcpTarget> =>
    clients
        // Manual (TOML) clients were never written to, so there is nothing to undo.
        .flatMap((client) => targetsFor(client, context))
        .filter(isJsonTarget)
        .filter((target) => scope === undefined || target.scope === scope);

/** `lunora mcp uninstall [client…]`. */
const runMcpUninstall = (options: McpUninstallOptions): McpUninstallResult => {
    const home = options.home ?? homedir();
    const platform = options.platform ?? process.platform;
    // Every client by default: a leftover entry in one we didn't think to check
    // is exactly the failure a user notices later.
    const clients = resolveClients(options.clients, () => MCP_CLIENTS, options.logger, "uninstall");

    if (clients === undefined) {
        return { code: 1, removed: [] };
    }

    const servers = targetServers(options);

    if (servers.length === 0) {
        // Both flags cancel out. Saying "nothing was configured" here would be a
        // lie — the servers may well be installed everywhere.
        options.logger.error("mcp uninstall: nothing to remove — `--docs-only` and `--local-only` are mutually exclusive, pass at most one.");

        return { code: 1, removed: [] };
    }

    const removed: { action: RemoveAction; client: string; path: string; server: string }[] = [];
    const context = { home, platform, projectRoot: options.cwd };

    for (const target of resolveTargets(clients, context, options.scope)) {
        for (const server of servers) {
            const result =
                options.print === true ? previewOne(target.client, server, target.path, options) : removeOne(target.client, server, target.path, options);

            // Only report files we actually changed: a run walks ~36
            // (client, scope, server) triples and all but one are typically
            // absent, which would make the result a debug log.
            if (result.action !== "absent") {
                removed.push({ ...result, client: target.client.id, server });
            }
        }
    }

    if (removed.length === 0) {
        options.logger.info("Nothing to remove — no Lunora MCP servers were configured in the clients checked.");
    } else if (options.print === true) {
        options.logger.info("Nothing was changed — re-run without --print to remove these.");
    }

    return { code: removed.some((entry) => entry.action === "invalid") ? 1 : 0, removed };
};

export type { McpUninstallOptions, McpUninstallResult };
export { runMcpUninstall };
