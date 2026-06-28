<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="vite" />

</a>

<h3 align="center">The Lunora Vite plugin: codegen, type sync, wrangler validation, and an error overlay over @cloudflare/vite-plugin</h3>

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

The Lunora Vite plugin. It wraps [`@cloudflare/vite-plugin`](https://www.npmjs.com/package/@cloudflare/vite-plugin) and layers on the project-specific pieces a Lunora app needs: codegen on save, type sync, `wrangler.jsonc` validation, and a runtime error overlay. `lunora()` returns a flat array of Vite plugins you drop straight into `plugins`.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/vite
```

```sh
yarn add @lunora/vite
```

```sh
pnpm add @lunora/vite
```

## Usage

```ts
// vite.config.ts
import { lunora } from "@lunora/vite";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [lunora()],
});
```

With no options, `lunora()` runs codegen on save, validates `wrangler.jsonc`, injects the error overlay, serves the Lunora studio at `/__lunora`, and includes `@cloudflare/vite-plugin`. Each piece is opt-out:

```ts
lunora({
    schemaDir: "lunora", // dir with schema.ts + function files
    generatedDir: "lunora/_generated", // where api.ts/server.ts/dataModel.ts land
    apiSpec: "openapi", // "openapi" | "openrpc" | "both" | "none"
    studio: false, // disable the /__lunora studio
    overlay: false, // disable the runtime error overlay
    validateWrangler: false, // skip the wrangler.jsonc binding check
    cloudflare: false, // bring your own @cloudflare/vite-plugin
});
```

`lunora()` returns a flat `Plugin[]`; Vite flattens nested plugin arrays, so `plugins: [lunora()]` works without spreading.

### Error overlay

The overlay surfaces dev-time failures in the browser. Lunora ships **solution finders** that turn the common ones — missing/invalid `defineSchema`, reserved or duplicate table names, a bad `.jurisdiction(...)`, a non-literal `unique`, a binding that isn't re-exported by your worker entry, and runtime unique-constraint / optimistic-concurrency conflicts — into an actionable fix hint right in the overlay.

`overlay` also accepts an options object forwarded to [`@visulima/vite-overlay`](https://www.npmjs.com/package/@visulima/vite-overlay), so you can add your own finders alongside Lunora's:

```ts
lunora({
    overlay: {
        // your finders run alongside Lunora's; either side can win per error via `priority`
        solutionFinders: [myCustomFinder],
    },
});
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/packages/vite)**.

## Related

- [`@lunora/cli`](https://www.npmjs.com/package/@lunora/cli) — the CLI; `lunora dev` builds on this plugin.
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

The Lunora vite package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/vite?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/vite
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/vite?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/vite
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
