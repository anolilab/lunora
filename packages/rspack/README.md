<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="rspack" />

</a>

<h3 align="center">The Lunora Rspack plugin: codegen, binding provisioning, and wrangler validation for Rspack projects</h3>

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

The Lunora [Rspack](https://rspack.rs) plugin. It runs `@lunora/codegen` before every compilation, writes the Cloudflare bindings your code implies into `wrangler.jsonc`, and validates that config against your schema — the build-time half of what [`@lunora/vite`](https://www.npmjs.com/package/@lunora/vite) does.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects.

## Install

```sh
npm install @lunora/rspack
```

```sh
yarn add @lunora/rspack
```

```sh
pnpm add @lunora/rspack
```

## Usage

With [Rsbuild](https://rsbuild.rs) — the recommended setup, and the one that runs your Worker:

```ts
// rsbuild.config.ts
import { lunoraRsbuild } from "@lunora/rspack/rsbuild";
import { defineConfig } from "@rsbuild/core";

export default defineConfig({
    plugins: [lunoraRsbuild()],
});
```

`rsbuild dev` now starts the client dev server **and** the Lunora Worker, and routes `/_lunora/*` to it. Nothing else to wire — no hand-written proxy, no second terminal, no `wrangler.dev.jsonc`. One entry registers codegen, binding provisioning, wrangler validation, the Worker, and the proxy.

To start from a working app, `lunora init -t rspack-react` scaffolds a React SPA and `lunora init -t tanstack-start-react-rspack` a TanStack Start app that deploys as one Worker.

On bare Rspack (or webpack 5), the plugin half works on its own — codegen and config only, no Worker:

```js
// rspack.config.mjs
import { lunoraRspack } from "@lunora/rspack";

export default {
    plugins: [lunoraRspack()],
};
```

## Options

```ts
lunoraRsbuild({
    projectRoot: process.cwd(), // directory containing `lunora/`
    schemaDir: "lunora", // where `schema.ts` and your function files live
    apiSpec: "openapi", // "openapi" | "openrpc" | "both" | "none"
    target: "cloudflare", // defaults to `target` in lunora.config.*
    validateWrangler: true, // set false to skip the wrangler.jsonc check

    // Rsbuild only:
    studio: true, // Lunora Studio at /__lunora (needs @lunora/studio)
    worker: true, // false to run the Worker yourself (the proxy is still injected)
    workerPort: 8787, // defaults to the wrangler config's `dev.port`, then 8787
    wranglerArgs: [], // extra arguments appended to `wrangler dev`
});
```

`LUNORA_CODEGEN=0` skips generation and the wrangler checks **in watch mode only**. A production build keeps generating: the ERROR-advisory gate is the only thing that fails it, so honouring the variable there would let an app ship against a surface its target cannot serve, green the whole way.

## How the Worker runs

Not in-process. `@cloudflare/vite-plugin` runs the Worker _inside_ the dev server using Vite's Environment API — a module runner in workerd pulls each module over RPC from Vite. Rspack has no equivalent runner protocol, and the alternative (bundling the Worker ourselves for Miniflare) would mean reimplementing wrangler's `nodejs_compat`, Durable Object migrations, binding wiring and local persistence.

So `lunoraRsbuild` spawns `wrangler dev` and proxies to it. From your seat that is the same DX — one command, Worker included. What differs is that the Worker **restarts** on change rather than hot-swapping modules, and the process boundary means a few Vite-plugin features have no counterpart:

| Feature                                  | Here            | Where to get it |
| ---------------------------------------- | --------------- | --------------- |
| Codegen on save, wrangler validation     | ✅              | —               |
| Binding / cron / compatibility-date sync | ✅              | —               |
| `.dev.vars` scaffolding + `WORKER_ENV`   | ✅ (watch mode) | —               |
| Worker running on `dev`                  | ✅ (Rsbuild)    | —               |
| Studio at `/__lunora`                    | ✅ (Rsbuild)    | —               |
| Browser error overlay                    | ❌              | `@lunora/vite`  |
| Per-module HMR inside the Worker         | ❌ (restarts)   | `@lunora/vite`  |
| Remote-binding dev (`LUNORA_REMOTE`)     | ❌              | `lunora dev`    |
| Class-A framework worker composition     | ❌              | `@lunora/vite`  |

## What each pass does

Before every compilation, in this order:

1. **Provision bindings** — infers the Durable Objects, their migration classes, and the `DB` D1 binding a `.global()` table implies, and writes them into `wrangler.jsonc`. Idempotent.
2. **Validate** — checks that config against the schema's requirements, and throws when it is short one (`validateWrangler: false` opts out).
3. **Generate** — runs `@lunora/codegen` into `<schemaDir>/_generated`, syncing your cron triggers and the compatibility date on the way.
4. **`postcodegen`** — runs the project's hook.

In watch mode the plugin registers your schema directory as a watch dependency, so editing _or adding_ anything under `lunora/` regenerates. The first pass of a session also scaffolds `.dev.vars` (it is gitignored, so a fresh clone has none and the Worker throws on its first required secret).

A production build **fails** on an ERROR-level schema advisory or platform diagnostic, exactly as `vite build` and `lunora deploy` do: the finding lands in `compilation.errors`, so no bundle is emitted and the CLI exits non-zero. A watch rebuild logs it and carries on — a half-typed schema should not take the watcher down. Codegen _crashes_ are reported the same way in both modes, never thrown out of the hook.

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/packages/rspack)**.

## Related

- [`@lunora/vite`](https://www.npmjs.com/package/@lunora/vite) — the Vite plugin, which runs the Worker in-process with per-module HMR.
- [`@lunora/cli`](https://www.npmjs.com/package/@lunora/cli) — the CLI; `lunora deploy` ships what this plugin generates.
- [`@lunora/codegen`](https://www.npmjs.com/package/@lunora/codegen) — the code generator run on schema changes.
- [`@lunora/config`](https://www.npmjs.com/package/@lunora/config) — shared `wrangler.jsonc` validation and binding inference.

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

The Lunora rspack package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/rspack?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/rspack
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/rspack?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/rspack
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
