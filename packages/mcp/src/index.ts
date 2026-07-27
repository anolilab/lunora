/**
 * `@lunora/mcp` — Model Context Protocol servers for Lunora. This entry exposes
 * a *deployment* to AI agents; the `@lunora/mcp/docs` subpath exposes the
 * framework's *documentation* (credential-free, and safe to host publicly).
 *
 * The deployment server: It registers tools for introspecting a deployment
 * (`lunora_list_functions`, `lunora_list_tables`) and invoking its functions
 * (`lunora_run_query`, plus `lunora_run_mutation` and `lunora_run_action` when
 * writes are enabled), each backed by `LunoraClient` over HTTP RPC. The server
 * is read-only by default — the write tools are exposed only when `allowWrites`
 * (or the `LUNORA_MCP_ALLOW_WRITES` env) is set, and every run tool is
 * allowlisted against the deployment's discovered public functions. It can also
 * front durable `@lunora/agent` runs as `agent_&lt;name>` tools when `allowAgents`
 * (or `LUNORA_MCP_ALLOW_AGENTS` + `LUNORA_MCP_AGENTS`) is set. Run the
 * `lunora-mcp` binary (configured via the `LUNORA_URL`, `LUNORA_ADMIN_TOKEN`,
 * and `LUNORA_MCP_ALLOW_WRITES` env vars) for the stdio transport, serve the
 * server remotely over Streamable HTTP with `createMcpFetchHandler` (a
 * Workers-ready `Request` → `Response` handler), or build a server
 * programmatically with `createLunoraMcpServer` and connect any transport.
 */
export type { CallAgentToolOptions, McpAgentExposure } from "./agent-tools";
export { AGENT_RUN_INPUT_SCHEMA, AGENT_STATUS_TOOL_NAME, agentToolDefinitions, callAgentTool, parseAgentsEnv } from "./agent-tools";
export type { McpServerInfo, McpTool } from "./compose";
export { createToolServer } from "./compose";
export type { DocsIndex, DocsPage, DocsPageSummary, DocsSearchHit } from "./docs";
export { callDocsTool, createRemoteDocsIndex, DEFAULT_DOCS_BASE_URL, DOCS_TOOL_DEFINITIONS, docsTools } from "./docs";
export type { McpFetchHandler } from "./http";
export { createMcpFetchHandler, serveStateless } from "./http";
export type { LocalDeployment, LocalDeploymentSource, LocalMcpServerOptions } from "./local";
export { connectLocalStdio, createLocalMcpServer, LOCAL_SERVER_NAME, localTools, NO_DEPLOYMENT_MESSAGE } from "./local";
export type { PaidMcpChargeConfig, PaidMcpServer, PaidMcpServerConfig, RegisterPaidToolOptions, RegisterToolOptions, ToolHandler } from "./paid";
export { createPaidMcpServer } from "./paid";
export type { LunoraMcpServerOptions } from "./server";
export { connectStdio, createLunoraMcpServer } from "./server";
export type { ToolDefinition, ToolInputSchema, ToolResult } from "./tools";
export { callTool, deploymentTools, READ_ONLY_TOOL_DEFINITIONS, toolDefinitions, WRITE_TOOL_DEFINITIONS } from "./tools";
