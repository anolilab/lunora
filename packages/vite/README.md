# @cirrus/vite

Vite plugin for the Cirrus framework. Wraps [`@cloudflare/vite-plugin`](https://www.npmjs.com/package/@cloudflare/vite-plugin) and layers on the project-specific pieces that a Cirrus app needs: codegen-on-save, `wrangler.jsonc` validation, and runtime error overlays.

The plugin is async and returns a flat **array** of Vite plugins, so you spread it into `defineConfig`. We deliberately defer all the Worker/Durable Object binding plumbing to `@cloudflare/vite-plugin` — we don't reinvent it.

Tested against TanStack Start and React Router v7. Anything else that builds on top of `@cloudflare/vite-plugin` should work too.

## Install

```bash
pnpm add -D @cirrus/vite vite
pnpm add -D @visulima/vite-overlay   # optional — runtime error overlay
```

Workspace dependencies: [`@cirrus/codegen`](../codegen), [`@cirrus/config`](../config). Peer deps: `vite` and (optional) `@visulima/vite-overlay`.

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { cirrus } from "@cirrus/vite";

export default defineConfig({
    plugins: [...(await cirrus())],
});
```

With options:

```ts
export default defineConfig({
    plugins: [
        ...(await cirrus({
            projectRoot: process.cwd(),
            schemaDir: "cirrus",
            generatedDir: "cirrus/_generated",
            overlay: true,
            validateWrangler: true,
            cloudflare: {
                /* forwarded to @cloudflare/vite-plugin */
            },
        })),
    ],
});
```

## What it does

The `cirrus(options)` factory composes up to four plugins in order:

1. **`cirrus:codegen`** — runs [`@cirrus/codegen`](../codegen) on `buildStart`. In dev mode, watches the schema directory and re-runs codegen on add/change/unlink, debounced 100ms. Test files (`*.test.ts`, `*.spec.ts`, anything under `__tests__/`) and files inside `_generated/` are filtered out. On a successful rerun the generated modules are invalidated in the module graph and the browser receives a `full-reload`.

2. **`cirrus:wrangler-validator`** — runs at `configResolved` and fails the dev server / build with helpful errors when `wrangler.jsonc` is missing the SHARD durable object, a recent-enough `compatibility_date` (`>= 2026-04-07`), the `web_socket_auto_reply_to_close` compatibility flag when `compatibility_date` predates 2026-04-07, or the `DB` D1 binding when any table is `.global()`. Disable with `validateWrangler: false` (not recommended).

3. **`@visulima/vite-overlay`** — dynamically imported. If the package isn't installed the plugin is silently a no-op. Disable explicitly with `overlay: false`.

4. **`@cloudflare/vite-plugin`** — dynamically imported and forwarded the value of `options.cloudflare`. Pass `cloudflare: false` to skip (e.g. when something upstream already includes it). Loading failures emit a warning but don't break the build.

## Options

| Option             | Default                    | Meaning                                                               |
| ------------------ | -------------------------- | --------------------------------------------------------------------- |
| `projectRoot`      | `process.cwd()`            | Resolves `schemaDir` and `wrangler.jsonc` against this.               |
| `schemaDir`        | `"cirrus"`                 | Directory containing `schema.ts` and your function files.             |
| `generatedDir`     | `"<schemaDir>/_generated"` | Where codegen writes `api.ts`, `server.ts`, `dataModel.ts`.           |
| `overlay`          | `true`                     | Inject `@visulima/vite-overlay` when installed.                       |
| `validateWrangler` | `true`                     | Enforce wrangler.jsonc against schema bindings.                       |
| `cloudflare`       | `{}`                       | Options forwarded to `@cloudflare/vite-plugin`. Pass `false` to skip. |

## API

| Export                              | Description                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `cirrus(options?)`                  | Async factory. Returns `ReadonlyArray<Plugin>`.                                                          |
| `codegenPlugin(resolved)`           | The codegen-on-save plugin in isolation.                                                                 |
| `wranglerValidatorPlugin(resolved)` | The wrangler.jsonc validator plugin in isolation.                                                        |
| `overlayPlugin()`                   | Async factory for the `@visulima/vite-overlay` plugin. Returns a no-op when the package isn't installed. |
| `VERSION`                           | Plugin version string.                                                                                   |

Types: `CirrusPluginOptions`, `ResolvedCirrusPluginOptions`, `CloudflarePluginOptions`, `CirrusPlugins`.

## Docs

- Repo root: [README.md](../../README.md)
- Vite reference: [apps/docs/content/docs/api/vite.mdx](../../apps/docs/content/docs/api/vite.mdx)
- Getting started: [apps/docs/content/docs/getting-started.mdx](../../apps/docs/content/docs/getting-started.mdx)

## License

MIT — see [LICENSE.md](../../LICENSE.md)
