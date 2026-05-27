# @cirrus/cli

The `cirrus` command-line interface for the Cirrus framework. Scaffolds new projects, runs the dev server, regenerates the typed API, validates `wrangler.jsonc`, deploys, and dispatches one-shot RPC calls against a running Worker.

## Install

The CLI is normally invoked via `pnpm dlx` so you don't need to add it to your project before scaffolding:

```bash
pnpm dlx @cirrus/cli init my-app
```

For projects that want to pin the version locally:

```bash
pnpm add -D @cirrus/cli
```

Workspace dependencies: [`@cirrus/codegen`](../cirrus-codegen), [`@cirrus/config`](../cirrus-config), [`@cirrus/vite`](../cirrus-vite).

## Commands

```
cirrus <command> [options]
```

| Command   | Description                                                          |
| --------- | -------------------------------------------------------------------- |
| `init`    | Scaffold a new Cirrus project from a template                        |
| `dev`     | Run the dev server (Vite + wrangler concurrently, or wrangler alone) |
| `codegen` | Re-emit `_generated/{api,server,dataModel}.ts` from `cirrus/`        |
| `deploy`  | Run codegen, validate `wrangler.jsonc`, then `wrangler deploy`       |
| `run`     | POST a single RPC to a running Worker (default `http://localhost:8787`) |
| `reset`   | Clear local Miniflare state (and `.cirrus-cache` with `--all`)       |

### `cirrus init`

```bash
cirrus init my-app                # default template: vite
cirrus init my-app -t standalone  # wrangler-only template
cirrus init my-app -t next        # not yet available — exits with code 1
```

Templates live in `plop-templates/{vite,standalone}/`. `next` is reserved but not yet shipped — the command warns and re-suggests `-t vite` or `-t standalone`.

Sample output:

```
scaffolded 23 files into /tmp/my-app
next steps:
  cd my-app
  pnpm install
  pnpm dev
```

### `cirrus dev`

```bash
cirrus dev               # auto-detects vite.config.* + wrangler.jsonc
cirrus dev --port 5174   # forwards --port to Vite (or wrangler if no Vite)
cirrus dev --no-vite     # wrangler-only mode
```

When both `vite.config.ts` and `wrangler.jsonc` exist, the command spawns Vite and `wrangler dev` concurrently, prefixing log lines with `[vite]` / `[wrangler]`. SIGINT propagates to both children.

### `cirrus codegen`

```bash
cirrus codegen
# -> codegen wrote dataModel.ts, api.ts, server.ts to /app/cirrus/_generated
```

Delegates to [`@cirrus/codegen`](../cirrus-codegen). Run after editing `cirrus/schema.ts` or any function file when you're not running the dev server.

### `cirrus deploy`

```bash
cirrus deploy --env production
```

Runs codegen, validates `wrangler.jsonc` against the schema's implied bindings (SHARD durable object, `DB` D1 binding when any table is `.global()`, compatibility flags), then shells out to `pnpm exec wrangler deploy [--env <name>]`. Aborts with exit code 1 on any validation error.

### `cirrus run`

```bash
cirrus run messages:send --args '{"body":"hi"}'
cirrus run messages:list --url http://localhost:8787 --shard room-1
```

POSTs to `<url>/_cirrus/rpc` with `{ functionPath, args, shardKey }`. Useful for smoke-testing functions without writing a client.

### `cirrus reset`

```bash
cirrus reset         # removes .wrangler/state
cirrus reset --all   # also removes .cirrus-cache
```

## API

The CLI also exports a programmatic entry point:

```ts
import { runCli } from "@cirrus/cli";

const exitCode = await runCli({ argv: ["dev", "--no-vite"], cwd: process.cwd() });
```

Public exports: `runCli`, `COMMANDS`, `VERSION`, `CommandName`, `RunCliOptions`.

## Docs

- Repo root: [README.md](../../README.md)
- CLI reference: [apps/docs/content/docs/api/cli.mdx](../../apps/docs/content/docs/api/cli.mdx)
- Getting started: [apps/docs/content/docs/getting-started.mdx](../../apps/docs/content/docs/getting-started.mdx)

## License

MIT — see [LICENSE.md](../../LICENSE.md)
