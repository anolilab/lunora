# @cirrus/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
a deployed Cirrus app to AI agents. It registers tools for introspecting a
deployment and invoking its functions, each backed by `@cirrus/client` over
HTTP RPC.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.

## Tools

| Tool                    | Description                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `cirrus_list_functions` | List public functions (queries, mutations, actions) and kinds.    |
| `cirrus_list_tables`    | List `.global()` tables and their column shapes.                  |
| `cirrus_run_query`      | Run a query and return its result (read-only).                    |
| `cirrus_run_mutation`   | Run a mutation and return its result (writes data).               |
| `cirrus_run_action`     | Run an action and return its result (may call external services). |

The `run_*` tools accept `{ functionPath, args?, shardKey? }`.

## Usage (stdio)

MCP clients spawn the `cirrus-mcp` binary and talk to it over stdio.
Configuration comes from the environment:

- `CIRRUS_URL` (required) — base URL of the deployed Worker.
- `CIRRUS_ADMIN_TOKEN` (optional) — bearer token sent on every RPC.

```jsonc
{
    "mcpServers": {
        "cirrus": {
            "command": "cirrus-mcp",
            "env": {
                "CIRRUS_URL": "https://app.example.workers.dev",
                "CIRRUS_ADMIN_TOKEN": "...",
            },
        },
    },
}
```

## Usage (programmatic)

```ts
import { createCirrusMcpServer } from "@cirrus/mcp";

const server = createCirrusMcpServer({ url: "https://app.example.workers.dev", token });
await server.connect(myTransport);
```

`connectStdio(options)` is a convenience wrapper that connects a
`StdioServerTransport` for you. Pass a pre-built `client` instead of `url` to
reuse an existing `CirrusClient`.

## API reference

### `createCirrusMcpServer(options)`

Builds a transport-agnostic MCP [`Server`](https://github.com/modelcontextprotocol/typescript-sdk) whose tools talk to a Cirrus deployment, and returns it. You call `.connect(transport)` yourself (or use `connectStdio` below). No WebSocket is opened — the tools dispatch over HTTP RPC — so the server is safe to run as a short-lived process. The MCP `initialize` handshake advertises the server as `cirrus` at the package's real version.

```ts
import { createCirrusMcpServer } from "@cirrus/mcp";

const server = createCirrusMcpServer({ url: "https://app.example.workers.dev", token: "..." });
await server.connect(myTransport);
```

`CirrusMcpServerOptions`:

| Field    | Type           | Description                                                                                          |
| -------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `url`    | `string`       | Base URL of the deployed Cirrus Worker. **Required unless `client` is given.**                       |
| `token`  | `string`       | Bearer token sent on every RPC (typically the admin token). Optional.                                |
| `fetch`  | `typeof fetch` | `fetch` implementation; defaults to the ambient global. Optional.                                    |
| `client` | `CirrusClient` | Pre-built client (e.g. for test injection). When given, `url`/`token`/`fetch` are ignored. Optional. |

Throws if neither `client` nor `url` is provided.

### `connectStdio(options)`

`(options: CirrusMcpServerOptions) => Promise<Server>`. Builds the server with `createCirrusMcpServer` and connects it over a `StdioServerTransport` — the transport MCP clients use when they spawn the `cirrus-mcp` binary. Resolves once the transport is connected; the process then stays alive serving requests.

```ts
import { connectStdio } from "@cirrus/mcp";

await connectStdio({ url: process.env.CIRRUS_URL!, token: process.env.CIRRUS_ADMIN_TOKEN });
```

### `TOOL_DEFINITIONS`

`ReadonlyArray<ToolDefinition>` — the five tool definitions the server registers (the table above), each `{ name, description, inputSchema }` with a JSON-Schema `inputSchema`. Exported so you can introspect or re-advertise the tool surface without standing up a server.

### `callTool(client, name, input)`

`(client: CirrusClient, name: string, input: Record<string, unknown>) => Promise<ToolResult>`. The raw dispatcher the server's `CallTool` handler delegates to — maps a tool name onto the matching `CirrusClient` method (`listFunctions`, `listGlobalTables`, `query`, `mutation`, `action`). Exported so the behaviour is unit-testable against a mock client without driving a transport. Unknown tool names and thrown errors are returned as `{ isError: true }` results (per the MCP convention) rather than rejecting; the run-tools read `{ functionPath, args?, shardKey? }` from `input`.

### Types

`CirrusMcpServerOptions`, `ToolDefinition` (`{ name, description, inputSchema }`), `ToolInputSchema` (a JSON-Schema `object`), `ToolResult` (`{ content: { type: "text"; text: string }[]; isError?: boolean }`).
