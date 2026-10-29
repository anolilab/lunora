// eslint-disable-next-line sonarjs/deprecation -- the low-level `Server` is the sanctioned choice here, as in `./server`: plain JSON Schema tools with no per-tool zod.
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { FunctionMcpServerOptions } from "./function-server";
import { createFunctionMcpServer } from "./function-server";

/**
 * Build a per-function server and connect it over stdio, the transport an editor
 * spawns. Resolves once the transport is connected; the process then stays alive
 * serving requests. Lives apart from `./stdio` for the same reason that module
 * does: the Worker entry's module graph never pulls in the stdio transport.
 */
// eslint-disable-next-line sonarjs/deprecation -- see the `Server` import above.
const connectFunctionStdio = async (options: FunctionMcpServerOptions): Promise<Server> => {
    const server = createFunctionMcpServer(options);

    await server.connect(new StdioServerTransport());

    return server;
};

export default connectFunctionStdio;
