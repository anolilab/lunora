<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="studio" />

</a>

<h3 align="center">The Lunora Studio: a local admin UI for your schema, data, logs, and advisors</h3>

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

The Lunora Studio: a local admin UI for your schema, data, logs, and advisors. It is an embeddable React component library — compose the panels yourself behind a `<LunoraProvider>`, mount the ready-made `<Studio>` shell, or use the batteries-included `<StudioApp>` / `mountStudio` entry. In `lunora dev`, `@lunora/vite` serves it at `/__lunora` with zero config.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/studio
```

```sh
yarn add @lunora/studio
```

```sh
pnpm add @lunora/studio
```

## Usage

```tsx
import { LunoraProvider } from "@lunora/react";
import { Studio } from "@lunora/studio";

const functions = [
    { kind: "query", path: "messages:list" },
    { kind: "mutation", path: "messages:send" },
];

<LunoraProvider client={client}>
    <Studio functions={functions} />
</LunoraProvider>;
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/addons/studio)**.

## Related

- [`@lunora/react`](https://www.npmjs.com/package/@lunora/react) — the `<LunoraProvider>` and hooks the panels render under.
- [`@lunora/vite`](https://www.npmjs.com/package/@lunora/vite) — serves the studio at `/__lunora` during `lunora dev`.
- [`@lunora/advisor`](https://www.npmjs.com/package/@lunora/advisor) — supplies the findings the Advisors view renders.

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

The Lunora studio package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/studio?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/studio
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/studio?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/studio
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
