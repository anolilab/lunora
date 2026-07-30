<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="config" />

</a>

<h3 align="center">Internal shared CLI + Vite config layer for Lunora: wrangler.jsonc validation, binding inference, and .dev.vars scaffolding</h3>

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

The internal shared CLI + Vite config layer for Lunora: `wrangler.jsonc` validation, binding inference and reconciliation, and `.dev.vars` scaffolding. **This package is internal** — it is consumed by [`@lunora/cli`](https://www.npmjs.com/package/@lunora/cli) and [`@lunora/vite`](https://www.npmjs.com/package/@lunora/vite) so they stay in lock-step. It is published for transparency; depend on the CLI or the Vite plugin and let them call into it rather than using it directly.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/config
```

```sh
yarn add @lunora/config
```

```sh
pnpm add @lunora/config
```

## Usage

Validate a project's `wrangler.jsonc` from disk. `validateWranglerProject` finds the config file, parses the JSONC, discovers the schema (to know whether a `DB` D1 binding or Vectorize bindings are required), and returns a structured report:

```ts
import { validateWranglerProject } from "@lunora/config/cloudflare";

const { report, wranglerPath } = validateWranglerProject({ projectRoot: process.cwd() });

if (!report.valid) {
    for (const error of report.errors) console.error(error);
}
for (const warning of report.warnings) console.warn(warning);
```

If you already hold a parsed config object, `validateWranglerConfig` (aliased as `validateWrangler`) is the pure, I/O-free form. Pass the discovered `SchemaInfo` so it knows which bindings the schema demands:

```ts
import { validateWranglerConfig } from "@lunora/config/cloudflare";

const report = validateWranglerConfig(wrangler, { hasGlobalTable: true });
// report: { valid: boolean; errors: string[]; warnings: string[] }
```

To parse a JSONC config yourself, use `readWranglerJsonc` / `findWranglerFile` rather than `JSON.parse` — the helpers tolerate comments and trailing commas.

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/deployment)**.

## Related

- [`@lunora/cli`](https://www.npmjs.com/package/@lunora/cli) — the CLI that drives this layer; use it instead of depending here directly.
- [`@lunora/vite`](https://www.npmjs.com/package/@lunora/vite) — the Vite plugin that shares the same validator.
- [`@lunora/codegen`](https://www.npmjs.com/package/@lunora/codegen) — discovers schema info used during validation.

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

The Lunora config package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/config?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/config
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/config?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/config
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
