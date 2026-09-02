<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="mcp" />

</a>

<h3 align="center">Model Context Protocol server exposing a Lunora deployment to AI agents</h3>

<!-- END_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<br />

<div align="center">

[![typescript-image][typescript-badge]][typescript-url]
[![FSL-1.1-Apache-2.0 licence][license-badge]][license]
[![npm version][npm-version-badge]][npm-version]
[![npm downloads][npm-downloads-badge]][npm-downloads]
[![PRs Welcome][prs-welcome-badge]][prs-welcome]

</div>

---

<div align="center">
    <p>
        <sup>
            Daniel Bannert's open source work is supported by the community on <a href="https://github.com/sponsors/prisis">GitHub Sponsors</a>
        </sup>
    </p>
</div>

---

[Model Context Protocol](https://modelcontextprotocol.io) servers for Lunora, in two flavours:

- **Deployment** (the main entry) — exposes a deployed Lunora app to AI agents: introspection tools (`lunora_list_functions`, `lunora_list_tables`, `lunora_get_function_schema`) and invocation tools (`lunora_run_query`, `lunora_run_mutation`, `lunora_run_action`), each backed by `@lunora/client` over HTTP RPC. Needs an admin token.
- **Documentation** ([`@lunora/mcp/docs`](#documentation-server)) — exposes the framework's _docs_ so an agent writing Lunora code can look up the real API instead of guessing. Credential-free, and safe to host publicly; Lunora runs it at `https://lunora.sh/mcp`.

Most users never install this package directly — `lunora mcp install` wires both servers into their editor. See [`@lunora/cli`](https://www.npmjs.com/package/@lunora/cli).

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Tools

| Tool                          | Description                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lunora_list_functions`       | List the deployment's public functions (queries, mutations, actions) with their kinds.                                                                        |
| `lunora_list_tables`          | List the deployment's `.global()` tables with their row counts.                                                                                               |
| `lunora_get_function_schema`  | Return a function's argument descriptors and kind by path, so a caller can construct a valid arguments object.                                                |
| `lunora_run_query`            | Run a query and return its result. Read-only.                                                                                                                 |
| `lunora_run_mutation`         | Run a mutation and return its result. Writes data — use with care.                                                                                            |
| `lunora_run_action`           | Run an action and return its result. May call external services.                                                                                              |
| `lunora_get_logs`             | Read the deployment's recent log entries (newest first). Requires an admin token.                                                                             |
| `lunora_get_issues`           | List errors grouped into Issues by fingerprint, with counts and triage status. Requires an admin token.                                                       |
| `lunora_get_advisories`       | List the deployment's schema/query advisories. Requires an admin token.                                                                                       |
| `lunora_get_query_insights`   | Per-statement execution counts and latency over a recent window. Requires an admin token.                                                                     |
| `lunora_get_migration_status` | Which migrations are applied and which are pending. Requires an admin token.                                                                                  |
| `agent_<name>`                | Start a durable [`@lunora/agent`](https://www.npmjs.com/package/@lunora/agent) run and await its answer. One tool per exposed agent. Requires agents enabled. |
| `lunora_agent_status`         | Poll a running agent by `threadKey` and return its answer once finished. Requires agents enabled.                                                             |

### Recommended agent flow

```
1. lunora_list_functions          → discover available paths and their kinds
2. lunora_get_function_schema     → retrieve the argument descriptors for a specific path
3. lunora_run_query / lunora_run_mutation / lunora_run_action
                                  → call the function with a well-formed arguments object
```

### Observability tools (privileged)

The five `lunora_get_*` observability tools are read-only, but they surface the
deployment's **operational data** — log lines, request metadata, and grouped
error messages, all of which may contain user data, and all of which land in the
model's context (and therefore at its provider). They are therefore **off by
default**: set `LUNORA_MCP_ALLOW_OBSERVABILITY=1` (or pass
`allowObservability: true`) to expose them. Without it they are omitted from
`ListTools` entirely and refused at dispatch, the same omit-don't-refuse rule the
write tools use. They are independent of `--allow-writes`, which is about
changing data, not reading operational data — and independent of the admin
bearer, which every tool already needs, so holding it is not the opt-in.

They return `structuredContent` alongside the usual text block, described by each
tool's `outputSchema` (MCP revision `2025-06-18` and later; older clients keep
reading the text block). All but `lunora_get_migration_status` take a `limit`
clamped server-side; migration status takes only `shardKey` and returns every
migration, because truncating that list would hide the pending one. Each also
takes an optional `shardKey` — on a `.shardBy()`-partitioned deployment these
reads are **per-shard**, not deployment-wide.

`lunora_get_function_schema` returns a JSON object with three fields:

- `path` — the function path (e.g. `"messages:send"`)
- `kind` — `"query"`, `"mutation"`, or `"action"`
- `args` — an array of argument descriptors (`name`, `kind`, `optional`, and optionally `element` or `table`)

## Install

```sh
npm install @lunora/mcp
```

Paid MCP tools (`createPaidMcpServer`) additionally need the optional peer [`@lunora/x402`](https://www.npmjs.com/package/@lunora/x402); it is loaded lazily, so installs that never charge for a tool don't pay for its dependency tree.

```sh
yarn add @lunora/mcp
```

```sh
pnpm add @lunora/mcp
```

## Usage

MCP clients spawn the `lunora-mcp` binary over stdio. Configuration comes from `LUNORA_URL` and `LUNORA_ADMIN_TOKEN` — both required (see [Tokens](#tokens)):

```jsonc
{
    "mcpServers": {
        "lunora": {
            "command": "lunora-mcp",
            "env": {
                "LUNORA_URL": "https://app.example.workers.dev",
                "LUNORA_ADMIN_TOKEN": "...",
            },
        },
    },
}
```

Or build a transport-agnostic server programmatically:

```ts
import { createLunoraMcpServer } from "@lunora/mcp";

const server = createLunoraMcpServer({ url: "https://app.example.workers.dev", token: "..." });
await server.connect(myTransport);
```

## Expose an agent

A deployment's durable [`@lunora/agent`](https://www.npmjs.com/package/@lunora/agent) agents can be fronted as MCP tools. This is **opt-in and fail-closed**, mirroring `allowWrites`: starting an agent run is a side effect, so the agent tools are omitted from the advertised list _and_ refused at dispatch unless you explicitly enable them. `@lunora/mcp` takes no dependency on `@lunora/agent` — it reaches the agent's public `agents:agentRun` mutation over RPC like any other function.

Enable it with two env vars (or the matching `createLunoraMcpServer` options):

- `LUNORA_MCP_ALLOW_AGENTS` — set to `1`/`true`/`yes`/`on` to expose the agent tools. Default: agents disabled.
- `LUNORA_MCP_AGENTS` — a `;`-separated list of `name:description` pairs selecting which agents to expose, e.g. `"support:Support questions;billing:Billing help"`.
- `LUNORA_MCP_AGENT_TIMEOUT_MS` (optional) — wall-clock budget a single `agent_<name>` call awaits before returning a pending result to poll.

```jsonc
{
    "mcpServers": {
        "lunora": {
            "command": "lunora-mcp",
            "env": {
                "LUNORA_URL": "https://app.example.workers.dev",
                "LUNORA_ADMIN_TOKEN": "...",
                "LUNORA_MCP_ALLOW_AGENTS": "1",
                "LUNORA_MCP_AGENTS": "support:Support questions;billing:Billing help",
            },
        },
    },
}
```

Each exposed agent gets an `agent_<name>` tool taking `prompt` (required), an optional `threadKey` (reuse to continue a conversation; omit to start a new thread), and an optional `title`. The tool starts a durable run and awaits it up to the timeout budget; if the run outlasts the budget it returns a pending result whose `threadKey` you feed to the generic `lunora_agent_status` tool to poll for the final answer.

Runs are **owner-scoped** to the identity the configured token resolves to — which is the deployment's **admin** identity, because `LUNORA_ADMIN_TOKEN` is what every tool needs (see [Tokens](#tokens)). Every agent thread this server starts therefore belongs to that one identity; run a separate MCP server per deployment if you need them kept apart.

### Tokens

`LUNORA_ADMIN_TOKEN` must be the deployment's **admin bearer**. It cannot be scoped down: `lunora_list_functions`, `lunora_list_tables`, and the allowlist precheck that runs before _every_ `lunora_run_*` call all hit admin-gated `/_lunora/admin/*` routes, so a least-privilege token returns `ADMIN_FORBIDDEN` on the first tool call. Constructing a server without one fails fast rather than advertising tools that cannot work.

The read-only guarantee therefore does **not** come from the token's scope — it comes from `LUNORA_MCP_ALLOW_WRITES` defaulting off, which omits the write tools from `tools/list` _and_ refuses them at dispatch. Treat the MCP server itself as the trust boundary: give it the admin token, and gate who can reach it (the OAuth-protected `createAuthedMcpFetchHandler` is the supported way to expose it beyond a local stdio process).

## Resources and annotations

Both servers implement MCP **tools**; the documentation server additionally exposes every page as an MCP **resource** (`lunora-docs:/docs/…`, `text/markdown`), so a client can enumerate and attach a page directly instead of the model having to guess a search query first.

Every tool carries **annotations** — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` and a human-facing `title` — so a client can badge the read-only surface and confirm before a write. They are hints; the actual guarantee is still made at dispatch, where a write tool is refused unless writes are enabled.

## Documentation server

`@lunora/mcp/docs` is a second, independent surface: it serves **published documentation**, not a deployment. No credentials, no writes, no `@lunora/client` — and no Node built-ins, so it runs unchanged on Workers, Netlify/Vercel functions, Deno, and Bun.

| Tool                 | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| `lunora_search_docs` | Search the docs; returns matching pages and sections with their URLs. |
| `lunora_get_doc`     | Return one page in full, as Markdown.                                 |
| `lunora_list_docs`   | List every page with its title and description.                       |

The tools read a `DocsIndex`, which has two implementations. A docs site wires up its own in-process index and mounts the server as an HTTP route:

```ts
import { createDocsMcpFetchHandler } from "@lunora/mcp/docs";

const handle = createDocsMcpFetchHandler({ index: myDocsIndex });

// e.g. in a Worker: export default { fetch: handle }
```

Anything else reads a published site over HTTP:

```ts
import { createDocsMcpServer, createRemoteDocsIndex } from "@lunora/mcp/docs";

const server = createDocsMcpServer({ index: createRemoteDocsIndex({ baseUrl: "https://lunora.sh" }) });
```

Point a client at the hosted endpoint with no install at all:

```sh
claude mcp add --transport http lunora-docs https://lunora.sh/mcp
```

### Hosting it safely

`createDocsMcpFetchHandler` screens each request before the transport sees it, because this surface is meant to be public and unauthenticated:

- **Bodies are capped** (128 KiB by default; override with `maxRequestBytes`).
- **JSON-RPC batches are refused.** The stateless transport buffers a whole batch's replies into one response, so a single small request carrying thousands of `tools/call` messages would amplify into hundreds of megabytes out, with no session to rate-limit against. A docs client gains nothing from batching.
- `lunora_search_docs` bounds its `query`, and `lunora_list_docs` caps how many pages it serialises.

## Local development server

`createLocalMcpServer` / `connectLocalStdio` compose the docs tools, the deployment tools, and any extra tools a host supplies into one stdio server — this is what `lunora mcp serve` runs.

```ts
import { connectLocalStdio } from "@lunora/mcp";

await connectLocalStdio({
    // Consulted per tool call, so a dev server started later is picked up
    // without reconnecting.
    deployment: () => readMyDevServer(),
    docs: { baseUrl: "https://lunora.sh" },
    extraTools: myLocalTools,
});
```

The deployment tools are advertised even when the resolver currently returns nothing — MCP clients cache the tool list, so a surface that appeared only when the dev server happened to be up would stay invisible for the rest of the session. Calling one with nothing running returns an actionable error instead.

The observability tools are the exception: their gate is snapshotted when the tool list is built, so a session started before `lunora dev` never advertises them (and the cached list keeps them absent afterwards). Restart the MCP server once the dev server is up.

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs)**.

## Related

- [`@lunora/client`](https://www.npmjs.com/package/@lunora/client) — the HTTP RPC client backing every tool.
- [`@lunora/cli`](https://www.npmjs.com/package/@lunora/cli) — deploy the app the server introspects and invokes.
- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — defines the queries, mutations, and actions the tools call.
- [`@lunora/agent`](https://www.npmjs.com/package/@lunora/agent) — the durable agents the `agent_<name>` tools front over RPC.

## Supported Node.js Versions

Libraries in this ecosystem make the best effort to track [Node.js' release schedule](https://github.com/nodejs/release#release-schedule).
Here's [a post on why we think this is important](https://medium.com/the-node-js-collection/maintainers-should-consider-following-node-js-release-schedule-ab08ed4de71a).

## Contributing

If you would like to help take a look at the [list of issues](https://github.com/anolilab/lunora/issues) and check our [Contributing](https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md) guidelines.

> **Note:** please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.

## Credits

- [Daniel Bannert](https://github.com/prisis)
- [All Contributors](https://github.com/anolilab/lunora/graphs/contributors)

## Made with ❤️ at Anolilab

This is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Anolilab](https://www.anolilab.com/open-source) is a Development and AI Studio. Contact us at [hello@anolilab.com](mailto:hello@anolilab.com) if you need any help with these technologies or just want to say hi!

## License

The Lunora mcp package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/mcp?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/mcp
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/mcp?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/mcp
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
