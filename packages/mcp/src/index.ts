/**
 * `@cirrus/mcp` — a Model Context Protocol server that exposes a Cirrus
 * deployment to AI agents.
 *
 * It registers tools for introspecting a deployment (`cirrus_list_functions`,
 * `cirrus_list_tables`) and invoking its functions (`cirrus_run_query`,
 * `cirrus_run_mutation`, `cirrus_run_action`), each backed by `CirrusClient`
 * over HTTP RPC.
 *
 * Run the `cirrus-mcp` binary (configured via `CIRRUS_URL` /
 * `CIRRUS_ADMIN_TOKEN`) for the stdio transport, or build a server
 * programmatically with `createCirrusMcpServer` and connect any transport.
 */
export type { CirrusMcpServerOptions } from "./server";
export { connectStdio, createCirrusMcpServer } from "./server";
export type { ToolDefinition, ToolInputSchema, ToolResult } from "./tools";
export { callTool, TOOL_DEFINITIONS } from "./tools";
