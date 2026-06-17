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

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a deployed Lunora app to AI agents. It registers tools for introspecting a deployment (`lunora_list_functions`, `lunora_list_tables`, `lunora_get_function_schema`) and invoking its functions (`lunora_run_query`, `lunora_run_mutation`, `lunora_run_action`), each backed by `@lunora/client` over HTTP RPC.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Tools

| Tool                         | Description                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `lunora_list_functions`      | List the deployment's public functions (queries, mutations, actions) with their kinds.                         |
| `lunora_list_tables`         | List the deployment's `.global()` tables and their column shapes.                                              |
| `lunora_get_function_schema` | Return a function's argument descriptors and kind by path, so a caller can construct a valid arguments object. |
| `lunora_run_query`           | Run a query and return its result. Read-only.                                                                  |
| `lunora_run_mutation`        | Run a mutation and return its result. Writes data — use with care.                                             |
| `lunora_run_action`          | Run an action and return its result. May call external services.                                               |

### Recommended agent flow

```
1. lunora_list_functions          → discover available paths and their kinds
2. lunora_get_function_schema     → retrieve the argument descriptors for a specific path
3. lunora_run_query / lunora_run_mutation / lunora_run_action
                                  → call the function with a well-formed arguments object
```

`lunora_get_function_schema` returns a JSON object with three fields:

- `path` — the function path (e.g. `"messages:send"`)
- `kind` — `"query"`, `"mutation"`, or `"action"`
- `args` — an array of argument descriptors (`name`, `kind`, `optional`, and optionally `element` or `table`)

## Install

```sh
npm install @lunora/mcp
```

```sh
yarn add @lunora/mcp
```

```sh
pnpm add @lunora/mcp
```

## Usage

MCP clients spawn the `lunora-mcp` binary over stdio. Configuration comes from `LUNORA_URL` (required) and `LUNORA_ADMIN_TOKEN` (optional bearer token):

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

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs)**.

## Related

- [`@lunora/client`](https://www.npmjs.com/package/@lunora/client) — the HTTP RPC client backing every tool.
- [`@lunora/cli`](https://www.npmjs.com/package/@lunora/cli) — deploy the app the server introspects and invokes.
- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — defines the queries, mutations, and actions the tools call.

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
