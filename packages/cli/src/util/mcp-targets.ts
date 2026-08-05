/**
 * Resolve the (client, config file, server) triples a `lunora mcp` subcommand
 * acts on.
 *
 * `install` and `uninstall` are the same program with a different verb: for each
 * client, for each of its config files, for each of our two servers, apply one
 * operation and report what happened. Only three things differ, and all three
 * are data rather than control flow — which client set, which scopes, and
 * whether manual (TOML) clients participate. Keeping the traversal here is what
 * stops the two commands from drifting apart; they already had, and the
 * divergence was a wrong message rather than a visible bug.
 */
import { existsSync } from "node:fs";

import { relative } from "@visulima/path";

import type { Logger } from "./logger";
import type { JsonMcpClient, McpClient, McpPathContext, McpScope } from "./mcp-clients";
import { findMcpClient, MCP_CLIENT_IDS, MCP_CLIENTS } from "./mcp-clients";

/** Both scopes, in the order a fallback prefers them. */
const SCOPES: ReadonlyArray<McpScope> = ["global", "project"];

/** One config file of one client, and the scope it belongs to. */
interface McpTarget {
    client: McpClient;
    path: string;
    scope: McpScope;
}

/** The same, narrowed to a client whose config we can read-modify-write. */
interface JsonMcpTarget extends McpTarget {
    client: JsonMcpClient;
}

/** A path relative to the project when it sits inside it, else the absolute path. */
const displayPath = (path: string, projectRoot: string): string => {
    const relativePath = relative(projectRoot, path);

    return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : path;
};

/** Every config file this client has on this machine. */
const targetsFor = (client: McpClient, context: McpPathContext): ReadonlyArray<McpTarget> => {
    const paths = client.paths(context);

    return SCOPES.flatMap((scope) => {
        const path = paths[scope];

        return path === undefined ? [] : [{ client, path, scope }];
    });
};

/**
 * The one config file a server should be written to for this client.
 *
 * `wanted` is the server's preferred scope; when the caller has not forced one,
 * the other scope is accepted as a fallback, because several clients only have
 * one (Zed has no project config, VS Code no global one) and skipping them would
 * silently install into half the list.
 */
const preferredTarget = (client: McpClient, context: McpPathContext, wanted: McpScope, forced: boolean): McpTarget | undefined => {
    const paths = client.paths(context);
    const fallback = wanted === "global" ? "project" : "global";
    const path = paths[wanted] ?? (forced ? undefined : paths[fallback]);

    if (path === undefined) {
        return undefined;
    }

    return { client, path, scope: paths[wanted] === undefined ? fallback : wanted };
};

/** Clients whose config file already exists in either scope — the ones the user demonstrably uses. */
const detectInstalledClients = (context: McpPathContext): ReadonlyArray<McpClient> =>
    MCP_CLIENTS.filter((client) => Object.values(client.paths(context)).some((path) => existsSync(path)));

/**
 * Turn the user's client arguments into clients.
 *
 * `fallback` is what an empty argument list means, and the two commands differ:
 * `install` targets only clients already configured here, while `uninstall`
 * targets every client — a leftover entry in one we didn't think to check is
 * exactly the failure a user notices later.
 */
const resolveClients = (
    ids: ReadonlyArray<string>,
    fallback: () => ReadonlyArray<McpClient>,
    logger: Logger,
    command: string,
): ReadonlyArray<McpClient> | undefined => {
    if (ids.length === 0) {
        return fallback();
    }

    const resolved: McpClient[] = [];

    for (const id of ids) {
        const client = findMcpClient(id);

        if (client === undefined) {
            logger.error(`mcp ${command}: unknown client "${id}". Known clients: ${MCP_CLIENT_IDS.join(", ")}.`);

            return undefined;
        }

        resolved.push(client);
    }

    return resolved;
};

/** True for a client whose config we write rather than print. */
const isJsonTarget = (target: McpTarget): target is JsonMcpTarget => target.client.format === "json";

export type { JsonMcpTarget, McpTarget };
export { detectInstalledClients, displayPath, isJsonTarget, preferredTarget, resolveClients, targetsFor };
