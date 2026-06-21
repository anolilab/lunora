/**
 * `@lunora/mcp` — a Model Context Protocol server that exposes a Lunora
 * deployment to AI agents.
 *
 * It registers tools for introspecting a deployment (`lunora_list_functions`,
 * `lunora_list_tables`) and invoking its functions (`lunora_run_query`,
 * `lunora_run_mutation`, `lunora_run_action`), each backed by `LunoraClient`
 * over HTTP RPC.
 *
 * Run the `lunora-mcp` binary (configured via `LUNORA_URL` /
 * `LUNORA_ADMIN_TOKEN`) for the stdio transport, or build a server
 * programmatically with `createLunoraMcpServer` and connect any transport.
 */
export type { LunoraMcpServerOptions } from "./server";
export { connectStdio, createLunoraMcpServer } from "./server";
export type { ToolDefinition, ToolInputSchema, ToolResult } from "./tools";
export { callTool, TOOL_DEFINITIONS } from "./tools";
