<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="analytics" />

</a>

<h3 align="center">Cloudflare Analytics Engine for Cirrus: typed writeDataPoint helper and SQL-API read client</h3>

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

Cloudflare Analytics Engine telemetry for Cirrus. The **write** side wraps an `AnalyticsEngineDataset` binding (`env.ANALYTICS`) in a typed, fire-and-forget `writeDataPoint` helper bound to `ctx.analytics` — plus an ergonomic `track(name, { dimensions, metrics, index })` that maps named fields onto AE's positional `blob`/`double`/`index` columns. The **read** side wraps the Analytics Engine SQL API so Cirrus Studio (and `@cirrus/advisor` runtime lints) can render real usage/latency panels.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @cirrus/analytics
```

```sh
yarn add @cirrus/analytics
```

```sh
pnpm add @cirrus/analytics
```

## Usage

### Write side (`ctx.analytics`)

Importing `@cirrus/analytics` in a `cirrus/` source auto-reconciles the self-describing `analytics_engine_datasets` binding (`{ binding: "ANALYTICS", dataset: "ANALYTICS" }`) and wires `ctx.analytics` onto every context. The write is a side-effect-only telemetry emit — sampled and fire-and-forget, never read back in-handler.

```ts
export const send = mutation({
    args: { roomId: v.id("rooms") },
    handler: async (ctx, { roomId }) => {
        // ...
        ctx.analytics.track("function_call", {
            dimensions: { fn: "messages:send", shard: roomId },
            index: "messages:send",
            metrics: { durationMs: 12 },
        });
    },
});
```

AE caps a data point at **20 blobs, 20 doubles, and 1 index**; `writeDataPoint` throws on overflow so a misuse surfaces in dev instead of silently dropping columns.

### Read side (SQL API)

```ts
import { createAnalyticsSqlClient } from "@cirrus/analytics";

const sql = createAnalyticsSqlClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN, // Analytics Read scope — a secret, not a binding
});

const result = await sql.query("SELECT blob1 AS fn, count() AS calls FROM ANALYTICS GROUP BY fn");
```

The API token is an account-scoped secret you provision in `.dev.vars`/env — it is **never** auto-scaffolded with a real value.

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://cirrus.dev/docs/addons/analytics)**.

## Related

- [`@cirrus/server`](https://www.npmjs.com/package/@cirrus/server) — emit telemetry from queries, mutations, and actions.
- [`@cirrus/studio`](https://www.npmjs.com/package/@cirrus/studio) — renders the Analytics usage panel backed by the SQL API.
- [`@cirrus/advisor`](https://www.npmjs.com/package/@cirrus/advisor) — runtime lints that can consume AE scan-attribution metrics.

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

The Cirrus analytics package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/cirrus/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@cirrus/analytics?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@cirrus/analytics
[npm-downloads-badge]: https://img.shields.io/npm/dm/@cirrus/analytics?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@cirrus/analytics
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
