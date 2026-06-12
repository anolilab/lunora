<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="astro" />

</a>

<h3 align="center">Astro integration for Cirrus — single-worker composition plus reactive-loader server helpers</h3>

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

The Astro integration for Cirrus. Astro is multi-framework at the UI layer, so this is not a new reactive runtime — reactivity comes from whichever island adapter you hydrate with. Instead it owns two server-side seams: `withCirrus` for single-worker composition inside Astro's `@astrojs/cloudflare` worker, and the reactive-loader server helpers in `@cirrus/astro/server` for preloading queries in `.astro` frontmatter.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @cirrus/astro
```

```sh
yarn add @cirrus/astro
```

```sh
pnpm add @cirrus/astro
```

## Usage

```ts
// astro.config.mjs — add the integration.
import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";
import { cirrus } from "@cirrus/astro";

export default defineConfig({
    output: "server",
    adapter: cloudflare(),
    integrations: [cirrus()],
});

// src/worker.ts — wrap the adapter's worker so Cirrus mounts under /_cirrus/*.
import astroWorker from "../dist/_worker.js/index.js";
import { withCirrus } from "@cirrus/astro";

export default {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) => withCirrus(astroWorker, { shardDO: env.SHARD }).fetch(request, env, ctx),
};
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://cirrus.dev/docs/frameworks/bring-your-framework)**.

## Related

- `@cirrus/client/ssr` — the server preload contract re-exported by `@cirrus/astro/server`.
- [`@cirrus/runtime`](https://www.npmjs.com/package/@cirrus/runtime) — the Worker runtime `withCirrus` composes with.
- [`@cirrus/react`](https://www.npmjs.com/package/@cirrus/react) — an island adapter for hydrating preloaded queries live.
- [`@cirrus/solid`](https://www.npmjs.com/package/@cirrus/solid) — another island adapter for live hydration.

## Supported Node.js Versions

Libraries in this ecosystem make the best effort to track [Node.js' release schedule](https://github.com/nodejs/release#release-schedule).
Here's [a post on why we think this is important](https://medium.com/the-node-js-collection/maintainers-should-consider-following-node-js-release-schedule-ab08ed4de71a).

## Contributing

If you would like to help take a look at the [list of issues](https://github.com/anolilab/cirrus/issues) and check our [Contributing](https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md) guidelines.

> **Note:** please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.

## Credits

- [Daniel Bannert](https://github.com/prisis)
- [All Contributors](https://github.com/anolilab/cirrus/graphs/contributors)

## Made with ❤️ at Anolilab

This is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Anolilab](https://www.anolilab.com/open-source) is a Development and AI Studio. Contact us at [hello@anolilab.com](mailto:hello@anolilab.com) if you need any help with these technologies or just want to say hi!

## License

The Cirrus astro package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/cirrus/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@cirrus/astro?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@cirrus/astro
[npm-downloads-badge]: https://img.shields.io/npm/dm/@cirrus/astro?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@cirrus/astro
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
