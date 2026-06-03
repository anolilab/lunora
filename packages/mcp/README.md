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
