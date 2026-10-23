import type { FunctionReference } from "@lunora/client";
import { LunoraClient } from "@lunora/client";
// eslint-disable-next-line sonarjs/deprecation -- the low-level `Server` is the sanctioned choice here, as in `./server`: plain JSON Schema tools with no per-tool zod.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import pkg from "../package.json";
import { coerceArgs } from "./function-args";
import type { FunctionKind, FunctionRoute, FunctionTools } from "./function-tools";
import { functionToolsFromOpenRpc } from "./function-tools";
import { errorFromThrown, errorResult, ok, okStructured } from "./tool-result";
import type { ToolResult } from "./tool-types";
import { readArgumentsBag } from "./tools";
import { readConfirmation, screenWriteConfirmation } from "./write-confirmation";

/**
 * Serve a developer's own Lunora app over MCP: one tool per query, mutation and
 * action, each taking its arguments as a typed JSON Schema.
 *
 * Identity is the caller's, not an admin's. The `token` is the bearer the app
 * already uses for its own RPC calls, so auth and row-level security apply to
 * every tool call exactly as they do to the app. Nothing here calls an
 * `/_lunora/admin/*` route, so this server needs no admin token.
 *
 * The tool list comes from the static `openRpcSpec` the app was generated with,
 * so `tools/list` makes no network call. That document exists only when the
 * project sets `apiSpec: "openrpc"` or `"both"`.
 */

const SERVER_NAME = "lunora";

interface FunctionMcpServerOptions {
    /**
     * Advertise and allow mutation and action tools. Off by default. A closed write
     * is not listed and is refused at dispatch.
     */
    allowWrites?: boolean;
    fetch?: typeof fetch;
    /** The MCP server name clients show. Defaults to `lunora`. */
    name?: string;
    /** The `openRpcSpec` export of `_generated/openrpc`. */
    openRpcSpec: unknown;
    /** The CALLER's bearer. Writes need one: the confirmation digest is keyed by it. */
    token?: string;
    /** The Lunora deployment URL the app talks to. */
    url: string;
    version?: string;
}

const reference = (path: string): FunctionReference => {
    return { __lunoraRef: path };
};

/** An empty shard key is the unsharded default, so it is coerced to `undefined` rather than forwarded. */
const shardKeyOf = (input: Record<string, unknown>): string | undefined =>
    typeof input["shardKey"] === "string" && input["shardKey"].length > 0 ? input["shardKey"] : undefined;

/**
 * Shape a function's result for the wire. A declared object output is returned
 * as `structuredContent`, which the SDK checks against the `outputSchema`. A
 * non-object output is wrapped as `{ result }`, because MCP requires an object
 * root. The text block carries the same value either way.
 */
const resultOf = (route: FunctionRoute, value: unknown): ToolResult => {
    if (route.outputMode === "object") {
        // `.output()` already validated this value on the server (`applyOutput`), so the
        // object shape the schema promises is the one the caller receives.
        return okStructured(value as Record<string, unknown>);
    }

    if (route.outputMode === "wrapped") {
        return okStructured({ result: value });
    }

    return ok(value);
};

/**
 * The write half: the confirmation handshake, then the call. A proposal is
 * returned in place of the call until its digest is confirmed.
 */
const runWrite = async (
    client: LunoraClient,
    route: FunctionRoute,
    tool: string,
    input: Record<string, unknown>,
    args: Record<string, unknown>,
    shardKey: string | undefined,
): Promise<ToolResult> => {
    const kind: Exclude<FunctionKind, "query"> = route.kind === "action" ? "action" : "mutation";
    const confirmation = readConfirmation(input);
    const gate = await screenWriteConfirmation(
        client,
        { args, functionPath: route.path, idempotencyKey: confirmation.idempotencyKey, kind, shardKey, tool },
        confirmation,
        route.sensitiveArgs,
        // The function is named by the tool, so the second call resends only what the input carries.
        ["args", "shardKey", "idempotencyKey"],
    );

    if (gate !== undefined) {
        return gate;
    }

    // A sensitive argument travels on a sensitive reference, so the client never queues
    // the call offline. This mirrors the generic write path in `./tools`.
    const target = route.sensitiveArgs.length === 0 ? reference(route.path) : { __lunoraRef: route.path, sensitive: true as const };

    const value = kind === "action" ? await client.action(target, args, { shardKey }) : await client.mutation(target, args, { onlineOnly: true, shardKey });

    return resultOf(route, value);
};

/**
 * Dispatch one tool call. A query runs at once. A mutation or action passes the
 * same two-step confirmation the generic write tools use, so a model that calls
 * it directly gets a proposal back and runs nothing.
 *
 * Exported so the gate and the handshake can be exercised without a transport.
 */
const callFunctionTool = async (
    client: LunoraClient,
    routes: FunctionTools["routes"],
    name: string,
    input: Record<string, unknown>,
    allowWrites: boolean,
): Promise<ToolResult> => {
    const route = routes.get(name);

    if (route === undefined) {
        return errorResult("NOT_FOUND", `unknown tool: ${name}`);
    }

    if (route.kind !== "query" && !allowWrites) {
        return errorResult("FORBIDDEN", `tool "${name}" is disabled: this MCP server is read-only. Enable writes with allowWrites.`);
    }

    try {
        const args = coerceArgs(route.argsSchema, readArgumentsBag(input["args"]));
        const shardKey = shardKeyOf(input);

        if (route.kind === "query") {
            return resultOf(route, await client.query(reference(route.path), args, { shardKey }));
        }

        return await runWrite(client, route, name, input, args, shardKey);
    } catch (error: unknown) {
        return errorFromThrown(error);
    }
};

/**
 * Build an MCP `Server` with one tool per function in `openRpcSpec`. Transport
 * agnostic: call `.connect(transport)` yourself.
 *
 * Throws at construction when the document is malformed or two functions share a
 * tool name, so a bad integration fails at startup rather than on the first call.
 */
// eslint-disable-next-line sonarjs/deprecation -- see the `Server` import above.
const createFunctionMcpServer = (options: FunctionMcpServerOptions): Server => {
    const client = new LunoraClient({ fetch: options.fetch, url: options.url });

    if (options.token !== undefined) {
        client.setAuthToken(options.token);
    }

    const allowWrites = options.allowWrites ?? false;
    const { definitions, routes } = functionToolsFromOpenRpc(options.openRpcSpec, { allowWrites });
    // eslint-disable-next-line sonarjs/deprecation -- see the `Server` import above.
    const server = new Server({ name: options.name ?? SERVER_NAME, version: options.version ?? pkg.version }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, () => {
        return { tools: [...definitions] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> =>
        callFunctionTool(client, routes, request.params.name, request.params.arguments ?? {}, allowWrites),
    );

    return server;
};

export type { FunctionMcpServerOptions };
export { callFunctionTool, createFunctionMcpServer };
