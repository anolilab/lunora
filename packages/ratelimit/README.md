<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="ratelimit" />

</a>

<h3 align="center">Rate limiting: token-bucket / fixed-window / sliding-window algorithms, deny list, sharding, pluggable stores, and procedure middleware</h3>

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

Rate limiting for Lunora: token-bucket, fixed-window, and sliding-window algorithms, a deny list, optional sharding for hot limits, pluggable stores (in-memory, SQL, or the Lunora ORM), and procedure middleware that rides the `.use()` chain.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/ratelimit
```

```sh
yarn add @lunora/ratelimit
```

```sh
pnpm add @lunora/ratelimit
```

## Usage

Build one `RateLimiter` from a config map, then attach the `rateLimit` middleware
to a procedure's `.use(...)` chain. The procedure builders (`mutation`, …) come
from your app's generated `_generated/server` module, not from a package.

```ts
import { dbRateLimit } from "@lunora/ratelimit";

import { mutation } from "./_generated/server";

const config = {
    login: { kind: "fixed window", period: 60_000, rate: 5 },
    send: { kind: "token bucket", period: 1_000, rate: 10 },
};

// `dbRateLimit` builds the limiter per call, backed by a Lunora table via
// `ctx.db`, so the count is durable. A `RateLimiter` built with no explicit
// `store` falls back to `createMemoryStore` (a per-instance in-memory Map) —
// fine for a limit that only ever needs to hold within one Durable Object
// instance, but a limiter like `login` needs a durable store or it stops
// enforcing the configured rate the moment the DO instance is sharded,
// replicated, or recreated.
// As procedure middleware — throws a structural LunoraError (429/403) on rejection.
// `key` must resolve to a string — a resolver returning `undefined` throws
// rather than silently sharing one bucket across every keyless caller.
export const send = mutation.use(dbRateLimit(config, "send", { key: (ctx) => ctx.auth.userId ?? "anonymous" })).mutation(async ({ ctx }) => {
    // …
});
```

Or call the limiter directly, inside a mutation/action so `ctx.db` is available.
A login limiter belongs in an **action**: a mutation's `ctx.db` writes ride its
storage transaction, so a handler that throws (a wrong password) rolls the
consumed unit back and every failed attempt is free. An action's writes commit
on their own, so the charge stays whether or not the handler throws.

```ts
import { RateLimiter, RateLimitError, createDbStore } from "@lunora/ratelimit";

import { action } from "./_generated/server";

export const login = action.action(async ({ ctx, args }) => {
    const limiter = new RateLimiter({ config, store: createDbStore({ db: ctx.db }) });
    const status = await limiter.limit("login", { key: args.email });

    if (!status.ok) {
        // Stop here — `limit` returns a failing status by default rather than
        // throwing, so falling through authenticates the rejected attempt.
        // status.retryAfter is milliseconds until the request would succeed.
        // status.reason is "rate" or "deny".
        throw new RateLimitError(status);
    }

    await authenticate(args);
});
```

For durable per-DO state inside a procedure, back the limiter with a Lunora
table via `dbRateLimit(config, name, options)`, or supply a `store`
(`createSqlStore` / `createDbStore`). `createMemoryStore` stays the default —
correct inside a single Durable Object — but constructing a `RateLimiter` with
no explicit `store` now warns once so that choice is visible instead of
silent.

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs)**.

## Related

- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — server primitives whose `.use()` chain the middleware rides.
- [`@lunora/do`](https://www.npmjs.com/package/@lunora/do) — Durable Objects providing the SQL storage backing durable limits.
- [`@lunora/values`](https://www.npmjs.com/package/@lunora/values) — validators for the schema you store rate-limit rows in.

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

The Lunora ratelimit package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/ratelimit?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/ratelimit
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/ratelimit?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/ratelimit
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
