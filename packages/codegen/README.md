<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="codegen" />

</a>

<h3 align="center">Code generator for Lunora: emits _generated/{api,server,dataModel}.ts from your schema</h3>

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

The Lunora code generator. It parses your `lunora/schema.ts` plus every function file under `lunora/`, then writes `lunora/_generated/` so the rest of your app gets typed access to its own backend. The core outputs are `api.ts` (the `api` / `internal` function references), `server.ts` (the `query` / `mutation` / `action` / `internalQuery` / `internalMutation` / `internalAction` / `definePolicy` procedure builders bound to your schema), and `dataModel.ts` (the `Doc` / `Id` types). It also emits `app.ts`, `functions.ts`, `shard.ts`, Drizzle schemas, and — when the relevant features are used — `crons.ts`, `containers.ts`, `workflows.ts`, `vectors.ts`, `seed.ts`, and OpenAPI/OpenRPC specs.

Most apps never call this package directly — the `lunora codegen` CLI command and the `@lunora/vite` plugin invoke it for you.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/codegen
```

```sh
yarn add @lunora/codegen
```

```sh
pnpm add @lunora/codegen
```

## Usage

```ts
import { formatAdvisories, runCodegen } from "@lunora/codegen";

const result = runCodegen({ projectRoot: process.cwd() });

console.log(`wrote _generated/ -> ${result.outputDirectory}`);

// Static schema advisories (e.g. unindexed foreign keys) found this run.
// runCodegen does not print them; surface them through your own channel.
if (result.advisories.length > 0) {
    console.warn(formatAdvisories(result.advisories));
}
```

`runCodegen` takes a single `CodegenOptions` object. The common fields:

- `projectRoot` (required) — directory containing the `lunora/` folder.
- `dryRun` — run discovery + emit (so parse errors still surface) without writing files. `outputDirectory` is still the path that would have been written.
- `lint` — run the static schema advisor (default `true`); when `false`, `result.advisories` is empty.
- `apiSpec` — `"openapi"` (default), `"openrpc"`, `"both"`, or `"none"`; controls which machine-readable API spec files get written.
- `lunoraDirectory` — override the `lunora` subdirectory name.

The emitted `_generated/*` modules are consumed under NodeNext, so their imports carry `.js` extensions — for example `import { api } from "./_generated/api.js"`. This is the one place in the codebase where hand-written `.js` extensions are correct.

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/concepts/schema)**.

## Related

- [`@lunora/cli`](https://www.npmjs.com/package/@lunora/cli) — the `lunora codegen` command calls into this package.
- [`@lunora/vite`](https://www.npmjs.com/package/@lunora/vite) — runs codegen on schema changes during dev.
- [`@lunora/values`](https://www.npmjs.com/package/@lunora/values) — the `v.*` validators the parser understands.

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

The Lunora codegen package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/codegen?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/codegen
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/codegen?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/codegen
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
