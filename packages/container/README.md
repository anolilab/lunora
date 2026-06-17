<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="container" />

</a>

<h3 align="center">Cloudflare Containers for Lunora: defineContainer, generated Container DO classes, and the ctx.containers action surface</h3>

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

Cloudflare Containers for Lunora: `defineContainer`, generated Container Durable Object classes, and the `ctx.containers` action surface.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/container
```

```sh
yarn add @lunora/container
```

```sh
pnpm add @lunora/container
```

## Usage

Declare containers in `lunora/containers.ts`:

```ts
import { defineContainer } from "@lunora/container";

export const transcoder = defineContainer({
    image: "./containers/transcoder", // dir with a Dockerfile, or { registry: "docker.io/acme/transcoder:1.4" }
    defaultPort: 8080,
    instanceType: "standard-1",
    maxInstances: 5,
    sleepAfter: "5m",
    secrets: ["TRANSCODER_API_KEY"], // forwarded from Worker secrets / .dev.vars
});
```

Codegen emits the Container Durable Object class into `_generated/containers.ts` (re-export it from your worker entry) and wires a typed handle onto `ActionCtx`:

```ts
export const transcode = action.input({ videoId: v.id("videos") }).action(async ({ args: { videoId }, ctx }) => {
    // one instance per entity
    const res = await ctx.containers.transcoder.get(videoId).fetch("/transcode", { method: "POST" });

    // or a random instance from a fixed pool
    const probe = await ctx.containers.transcoder.any().fetch("/healthz");
});
```

The config layer (`lunora dev` / `lunora deploy`) reconciles the wrangler `containers[]` entry, the `CONTAINER_*` Durable Object binding, and the SQLite-class migration automatically; `wrangler deploy` builds the Dockerfile with local Docker and pushes it to the Cloudflare Registry.

### Calling Lunora from inside a container

Container code calls back into your app's functions with the bridge client (any JS runtime), over the Worker's HTTP RPC endpoint:

```ts
import { createContainerBridge } from "@lunora/container/bridge";

const lunora = createContainerBridge({ baseUrl: process.env.LUNORA_URL!, token: process.env.LUNORA_TOKEN });

const pending = await lunora.query("jobs:listPending", { limit: 10 });
await lunora.mutation("jobs:markDone", { id: pending[0].id });
```

The token is a bearer your Worker's `resolveIdentity` recognizes — pass it to the container as a `secret`. Non-JS containers can `POST /_lunora/rpc` with `{ functionPath, args }` directly.

Secure the bridge in `resolveIdentity`: read `request.headers.get("authorization")`, strip the `Bearer ` prefix, and compare the token against a Worker secret (e.g. `env.LUNORA_CONTAINER_TOKEN`) you also forward to the container. Return a `{ userId }` identity only on a match and `null` otherwise — an unrecognised request then runs anonymously and is rejected by your functions' own authorization checks. See [Securing the bridge](https://lunora.sh/docs/addons/containers#securing-the-bridge) for the full example.

### Entry points

- `@lunora/container` — Node-safe: `defineContainer`, naming/normalization helpers, `createContainerContext`, and the Docker-free `createContainerTestContext` test double.
- `@lunora/container/do` — workerd-only: the `LunoraContainer` base class the generated DO classes extend (pulls in `@cloudflare/containers`).
- `@lunora/container/bridge` — runtime-agnostic: `createContainerBridge` for calling Lunora functions from inside a container.

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/addons/containers)**.

## Related

- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — defines the actions that drive containers via `ctx.containers`.
- [`@lunora/config`](https://www.npmjs.com/package/@lunora/config) — reconciles the wrangler `containers[]` entry and Durable Object binding.
- [`@lunora/runtime`](https://www.npmjs.com/package/@lunora/runtime) — the Worker runtime the bridge client calls back into.

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

The Lunora container package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/container?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/container
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/container?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/container
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
