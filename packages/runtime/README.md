<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="runtime" />

</a>

<h3 align="center">Lunora Worker runtime: the RPC router, shard resolver, and query coordinator</h3>

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

The Worker entry layer for Lunora. `createWorker(options)` returns a Cloudflare module Worker (`{ fetch, scheduled, serverQuery }`) that decodes the Lunora RPC envelope, routes each call to the right shard Durable Object, forwards WebSocket upgrades, and fans cross-shard reads out through the query coordinator. It also exports the shard resolver, the `QueryCoordinator`, and the secure-by-default HTTP edge (security headers, CORS, CSRF).

Most apps don't import this package directly — codegen emits a worker entry that calls `createWorker` for you. Reach for `@lunora/runtime` when you build a custom entrypoint, an add-on route, or your own transport.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/runtime
```

```sh
yarn add @lunora/runtime
```

```sh
pnpm add @lunora/runtime
```

## Usage

```ts
import type { LunoraWorker } from "@lunora/runtime";
import { createWorker } from "@lunora/runtime";

import { ShardDO } from "./shard";

interface Env {
    SHARD: DurableObjectNamespace;
}

// Bindings only exist per request, so build the worker lazily off `env` and
// reuse it for the isolate's lifetime.
let worker: LunoraWorker | null = null;

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        worker ??= createWorker({ shardDO: env.SHARD }); // shardDO is the one required option

        return worker.fetch(request, env, ctx);
    },
};

// Re-export the Durable Object so wrangler can bind it.
export { ShardDO };
```

`shardDO` is the one required option — the `DurableObjectNamespace` bound to your `ShardDO`. Everything else is opt-in: a `queryCoordinator` for cross-shard fan-out, `resolveIdentity` for auth, `security` for the HTTP edge, `crons` / `backupCron` for the scheduled handler, and the admin introspectors the Studio reads. `createWorker` returns `{ fetch, scheduled, serverQuery }`; wire `scheduled` too if you use crons or the built-in backup. See the docs for the full options table.

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/packages/runtime)**.

## Related

- [`@lunora/do`](https://www.npmjs.com/package/@lunora/do) — the `ShardDO` / `SessionDO` Durable Objects this runtime routes to.
- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — defines the queries, mutations, and actions the runtime executes.
- [`@lunora/d1`](https://www.npmjs.com/package/@lunora/d1) — backs `.global()` tables used by the query coordinator.

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

The Lunora runtime package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/runtime?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/runtime
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/runtime?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/runtime
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
