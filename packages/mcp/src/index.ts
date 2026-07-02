/**
 * `@lunora/mcp` — a Model Context Protocol server that exposes a Lunora
 * deployment to AI agents. It registers tools for introspecting a deployment
 * (`lunora_list_functions`, `lunora_list_tables`) and invoking its functions
 * (`lunora_run_query`, plus `lunora_run_mutation` and `lunora_run_action` when
 * writes are enabled), each backed by `LunoraClient` over HTTP RPC. The server
 * is read-only by default — the write tools are exposed only when `allowWrites`
 * (or the `LUNORA_MCP_ALLOW_WRITES` env) is set, and every run tool is
 * allowlisted against the deployment's discovered public functions. Run the
 * `lunora-mcp` binary (configured via the `LUNORA_URL`, `LUNORA_ADMIN_TOKEN`,
 * and `LUNORA_MCP_ALLOW_WRITES` env vars) for the stdio transport, or build a
 * server programmatically with `createLunoraMcpServer` and connect any transport.
 */
export type { LunoraMcpServerOptions } from "./server";
export { connectStdio, createLunoraMcpServer } from "./server";
export type { ToolDefinition, ToolInputSchema, ToolResult } from "./tools";
export { callTool, READ_ONLY_TOOL_DEFINITIONS, toolDefinitions, WRITE_TOOL_DEFINITIONS } from "./tools";
