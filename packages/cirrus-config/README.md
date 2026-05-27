# @cirrus/config

Shared configuration helpers for the Cirrus framework.

> **Internal package.** This is consumed by [`@cirrus/cli`](../cirrus-cli) and [`@cirrus/vite`](../cirrus-vite) so they share a single `wrangler.jsonc` validator and stay in lock-step. It is published for transparency, but the surface is **not** intended for direct consumer use — depend on the CLI or the Vite plugin instead and let them call into this package for you.

## Install

```bash
pnpm add @cirrus/config
```

Workspace dependency: [`@cirrus/codegen`](../cirrus-codegen) (used to discover schema info for validation).

## Usage

### Pure validator

`validateWrangler` (alias of `validateWranglerConfig`) takes a parsed `wrangler.jsonc` object and an optional `SchemaInfo` flag, and returns a structured report. It performs no I/O.

```ts
import { validateWrangler } from "@cirrus/config";

const wrangler = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));

const { valid, errors, warnings } = validateWrangler(wrangler, { hasGlobalTable: true });

if (!valid) {
    for (const error of errors) console.error(error);
}
```

### File-system aware

`validateWranglerProject` locates `wrangler.jsonc`/`wrangler.json` under `projectRoot`, parses it with `jsonc-parser` (trailing commas allowed), discovers the cirrus schema, and runs `validateWranglerConfig`. Returns the legacy `{ problems, wranglerPath, report }` shape kept for backward compatibility with the CLI.

```ts
import { validateWranglerProject } from "@cirrus/config";

const { problems, wranglerPath, report } = validateWranglerProject({ projectRoot: process.cwd() });
```

## What gets checked

Both entry points enforce the bindings that a Cirrus Worker needs at runtime:

- `durable_objects.bindings` must include `{ name: "SHARD", class_name: "ShardDO" }`
- `compatibility_flags` must include `"web_socket_auto_reply_to_close"`
- `compatibility_date` must be `>= "2026-04-07"`
- If the schema declares any `.global()` table, `d1_databases` must include a binding named `"DB"`

These constants are exported as `REQUIRED_FLAG` and `REQUIRED_COMPATIBILITY_DATE` for tests and tooling.

## API

| Export                                | Description                                                          |
| ------------------------------------- | -------------------------------------------------------------------- |
| `validateWrangler(config, schema?)`   | Pure validator. Alias of `validateWranglerConfig`. Returns `{ valid, errors, warnings }`. |
| `validateWranglerConfig(config, ...)` | Same as `validateWrangler`. Canonical name.                          |
| `validateWranglerProject(options)`    | Reads + parses `wrangler.jsonc` from disk, runs the validator, returns the legacy problems shape. |
| `REQUIRED_FLAG`                       | `"web_socket_auto_reply_to_close"`                                   |
| `REQUIRED_COMPATIBILITY_DATE`         | `"2026-04-07"`                                                       |

Types: `WranglerConfig`, `SchemaInfo`, `WranglerValidationReport`, `WranglerProjectValidationOptions`, `WranglerProjectValidationResult`.

The `wrangler-validator` subpath export (`@cirrus/config/wrangler-validator`) re-exports the same module for adapter authors who want to pin the import path.

## Docs

- Repo root: [README.md](../../README.md)
- Deployment guide: [apps/docs/content/docs/deployment.mdx](../../apps/docs/content/docs/deployment.mdx)

## License

MIT — see [LICENSE.md](../../LICENSE.md)
