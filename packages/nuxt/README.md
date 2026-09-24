<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="nuxt" />

</a>

<h3 align="center">Nuxt module for Lunora — single-worker composition (mounts /_lunora/* into Nitro) plus reactive-loader server helpers</h3>

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

A **Nuxt module** that runs Lunora and Nuxt as a **single Cloudflare Worker**.

Instead of Lunora owning the Cloudflare worker entry (the two-worker split), it
is mounted _inside_ Nitro: the module registers a server route at `/_lunora/**`
that forwards every Lunora RPC, WebSocket upgrade, and admin request to your
Lunora app in-process. One `wrangler.jsonc`, one deploy, a same-origin client.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```bash
npm install @lunora/nuxt
```

## Setup

```ts
// nuxt.config.ts
export default defineNuxtConfig({
    modules: ["@lunora/nuxt"],
    nitro: { preset: "cloudflare_module" },
});
```

Add a `worker.ts` wrapper at the project root and point `wrangler.jsonc`'s `main`
at it, so the `ShardDO` Durable Object class is exported from the deployed worker.
Nitro's `cloudflare_module` output exports only the SSR handler, so `main` must
point at the wrapper — not the raw `.output/server/index.mjs` — or `wrangler deploy`
fails on the missing DO class:

```ts
// worker.ts
export { default } from "./.output/server/index.mjs";
export { ShardDO } from "./lunora/server";
```

```jsonc
// wrangler.jsonc
{ "main": "worker.ts" }
```

`lunora/server.ts` is your built Lunora app (`defineApp().build()`) — its default
export is the worker (a `fetch` entrypoint), and it re-exports `ShardDO`. The
module aliases the `#lunora/app` virtual to it (configurable via the `lunora.appEntry`
option, default `~/lunora/server`) and serves it at the `/_lunora/**` route.

## Options

| Option     | Default           | Description                                               |
| ---------- | ----------------- | --------------------------------------------------------- |
| `appEntry` | `~/lunora/server` | Module specifier of the Lunora app entry (`#lunora/app`). |

The `/_lunora/**` mount is fixed: the worker routes on those exact paths and the
generated client calls them.

## How it works

- **The route** (`addServerHandler` at `/_lunora/**`): reconstructs a Web `Request`
  from the H3 event, resolves the Cloudflare `env`/`ExecutionContext` off it
  (tolerating both `event.context.cloudflare` and `event.req.runtime.cloudflare`),
  and forwards to your app's `fetch`. A missing Cloudflare runtime answers a clear 500.
- **`#lunora/app` alias**: points the route's worker import at your app entry,
  forwarded into the Nitro server bundle via `nuxt.options.alias`.
- **`ShardDO`** rides to the deployed worker through your root `worker.ts` wrapper
  (`wrangler.jsonc`'s `main`), which re-exports Nitro's SSR handler and `ShardDO`.

## Verify before deploy

Single-worker composition rides on two Nitro behaviours that vary across versions
— verify them on your pinned toolchain:

1. **WebSocket upgrade pass-through.** The live feed needs Nitro to return your
   Lunora app's `101 Switching Protocols` response (carrying its Cloudflare
   `webSocket`) untouched. RPC (plain JSON) works regardless; if live
   subscriptions never connect while RPC does, Nitro is normalising the upgrade
   response and `/_lunora/ws` needs a deploy-boundary handoff instead of the H3
   route return.
2. **`worker.ts` wrapper.** `wrangler.jsonc`'s `main` must point at a root
   `worker.ts` that re-exports Nitro's SSR handler _and_ `ShardDO` — Nitro's
   `cloudflare_module` output exports only the SSR handler. If `wrangler deploy`
   fails with "ShardDO class not exported", check that `main` points at the
   wrapper and that it re-exports `ShardDO`. The module `warn()`s when
   `worker.ts` is missing but can't verify wrangler's `main` points at it.

## Server data-loading

`@lunora/nuxt/server` re-exports the framework-neutral SSR helpers
(`createServerClient`, `preloadQuery`, …) from `@lunora/client/ssr` for the
reactive-loader handoff. Safe to import from a Nitro server route (no WebSocket,
no browser globals).

## Feature flags

`@lunora/nuxt` ships no flag composable — Nuxt _is_ Vue, so read `ctx.flags`
server-side (a Nitro route, a function, or a reactive loader) and pass the
resolved value down, or call `useFlag` / `useFlags` from
[`@lunora/vue`](https://www.npmjs.com/package/@lunora/vue) directly in a
component for live updates over the WebSocket. Requires
[`@lunora/flags`](https://www.npmjs.com/package/@lunora/flags) wired in
`lunora/flags.ts`.

```vue
<script setup lang="ts">
import { useFlag } from "@lunora/vue";

// Live over the Lunora WS — holds `false` until the server resolves it.
const newHero = useFlag("homepage-hero", false);
</script>

<template>
    <NewHero v-if="newHero" />
    <ClassicHero v-else />
</template>
```

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

The Lunora nuxt package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/nuxt?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/nuxt
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/nuxt?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/nuxt
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
