<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="studio-host" />

</a>

<h3 align="center">Internal shared studio dev-server helpers (HTML render, admin-token resolution, prebuilt asset loading) for @cirrus/vite and @cirrus/cli</h3>

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

> **Internal package.** `@cirrus/studio-host` is a private workspace package consumed by `@cirrus/vite` and `@cirrus/cli`. You should not depend on it directly — use the CLI or the Vite plugin, which call into it.

Internal shared studio dev-server helpers (HTML render, admin-token resolution, prebuilt asset loading) for `@cirrus/vite` and `@cirrus/cli`. Each surface owns its own transport (Connect middleware vs `node:http`) and routing; the genuinely shared parts live here so the dev studio behaves identically however the project is run.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @cirrus/studio-host
```

```sh
yarn add @cirrus/studio-host
```

```sh
pnpm add @cirrus/studio-host
```

## Usage

```ts
import { loadStudioAssets, renderStudioHtml, resolveAdminToken } from "@cirrus/studio-host";

const assets = await loadStudioAssets();
const adminToken = resolveAdminToken(env);
const html = renderStudioHtml({ adminToken, baseUrl: "http://localhost:8787" });
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://cirrus.dev/docs/addons/studio)**.

## Related

- [`@cirrus/studio`](https://www.npmjs.com/package/@cirrus/studio) — the prebuilt studio SPA these helpers host.
- [`@cirrus/vite`](https://www.npmjs.com/package/@cirrus/vite) — serves the studio from a Vite middleware at `/__cirrus`.
- [`@cirrus/cli`](https://www.npmjs.com/package/@cirrus/cli) — serves the studio from a standalone Node HTTP server during `cirrus dev`.

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

The Cirrus studio-host package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/cirrus/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@cirrus/studio-host?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@cirrus/studio-host
[npm-downloads-badge]: https://img.shields.io/npm/dm/@cirrus/studio-host?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@cirrus/studio-host
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
