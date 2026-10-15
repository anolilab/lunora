/* eslint-disable sonarjs/deprecation -- see server.ts: the low-level `Server` is the sanctioned choice for plain-JSON-Schema tools. */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import installedVersion from "./installed-version";
import type { LunoraMcpServerOptions } from "./server";
import { createLunoraMcpServer } from "./server";

/**
 * Build the server and connect it over stdio — the transport MCP clients use
 * when they spawn the `lunora-mcp` binary. Resolves once the transport is
 * connected; the process then stays alive serving requests.
 *
 * Lives apart from `server.ts` so the Worker entry's module graph never pulls
 * in the stdio transport (and its `node:process` import).
 */
const connectStdio = async (options: LunoraMcpServerOptions): Promise<Server> => {
    const version = installedVersion();
    const server = createLunoraMcpServer(version === undefined ? options : { version, ...options });

    await server.connect(new StdioServerTransport());

    return server;
};

export default connectStdio;
