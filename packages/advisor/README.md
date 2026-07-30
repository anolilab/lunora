<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="advisor" />

</a>

<h3 align="center">Schema &amp; query lints (splinter-style advisors) for Lunora, feeding the Studio Advisors view</h3>

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

Schema and query lints for Lunora, modeled on Supabase's splinter. Each lint is a pure rule over a normalized `LintContext`; `runAdvisor()` runs a set and flattens their findings for the CLI, the Vite plugin, and the Studio Advisors view.

Most lints are `static`: they run against the declared schema (and the query reads / inserts the codegen feeder discovers in your function bodies), so a problem surfaces at codegen time before it ships — the edge over a live-database-only advisor. A smaller `runtime` tier (`hot_shard`, `index_utilization`, `constraint_validator`) reads observed signal from a running deployment.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/advisor
```

```sh
yarn add @lunora/advisor
```

```sh
pnpm add @lunora/advisor
```

## Usage

You usually don't call this package directly — `@lunora/codegen` runs the static lints during `lunora dev` / `lunora codegen` and the Studio renders the findings. To run them yourself, adapt your schema with `fromServerSchema` and pass it to `runAdvisor`:

```ts
import { fromServerSchema, runAdvisor } from "@lunora/advisor";

import schema from "./lunora/schema";

// `source: "static"` skips the runtime lints, which need a live deployment.
const findings = runAdvisor({ schema: fromServerSchema(schema) }, { source: "static" });

for (const finding of findings) {
    // Finding has: level, name, title, detail, description, remediation, metadata, …
    console.log(`[${finding.level}] ${finding.name}: ${finding.detail}`);
}
```

`runAdvisor(context, options)` returns a flat `Finding[]` in lint-declaration order. Options:

- `lints` — the lint set to run (default `ALL_LINTS`; also exported: `STATIC_LINTS`, `RUNTIME_LINTS`, and each lint by name, e.g. `unindexedForeignKey`).
- `source` — restrict to one evidence tier, `"static"` or `"runtime"`. Omit to run both.

### Runtime lints

The runtime tier (`hot_shard`, `index_utilization`, `constraint_validator`) reads observed signal off the `LintContext` (`shardTraffic`, `tableScans`, `indexHits`, `tableSamples`). The Studio backend fills those from each shard's durable counters. As an alternative feeder, `loadAnalyticsRuntimeMetrics` reconstructs the same arrays from the Analytics Engine SQL API:

```ts
import { fromServerSchema, loadAnalyticsRuntimeMetrics, runAdvisor } from "@lunora/advisor";

import schema from "./lunora/schema";

// `client` is an `@lunora/bindings/analytics` SQL client (anything with `query(sql)`).
const metrics = await loadAnalyticsRuntimeMetrics(client, { dataset: "ANALYTICS" });
const findings = runAdvisor({ schema: fromServerSchema(schema), ...metrics }, { source: "runtime" });
```

A missing metric degrades to an empty array rather than throwing, so a partially configured read path still returns what it can.

### Observability map (score, coverage, baseline)

`runAdvisor` answers "what is wrong?". `scoreAdvisor` answers "how are we doing, and did it get worse?" — a scored coverage map over your procedures, modeled on [`evlog map`](https://www.evlog.dev/cli/map). It is a pure function over findings you already have, so it never re-runs a lint:

```ts
import { runAdvisor, scoreAdvisor } from "@lunora/advisor";

const findings = runAdvisor(context, { source: "static" });
const map = scoreAdvisor(context, findings);

console.log(map.score, map.grade); // 84 "good"
console.log(map.summary); // { dark: 1, exempt: 0, findings: 6, instrumented: 9, partial: 2, procedures: 12 }
```

Each procedure starts at 100 and loses each fired lint's weight (`Lint.weight`, else a severity ladder: `ERROR` 20 / `WARN` 10 / `INFO` 5), then rolls up into a weighted global mean — public handlers count double, internal ones and queries half. Findings that name no procedure (schema shape, wrangler config) land in a project bucket that also counts toward the grade.

Commit the map and gate CI on it:

```ts
import { compareToBaseline, parseAdvisorMap } from "@lunora/advisor";

const baseline = parseAdvisorMap(JSON.parse(await readFile("lunora.advisor.map.json", "utf8")));
const diff = baseline && compareToBaseline(map, baseline);

// Three independent signals: the global score fell, an existing procedure got
// worse, or one went dark. The middle one catches a refactor that guts a single
// handler while leaving the mean flat.
if (diff?.regressed) {
    process.exitCode = 1;
}
```

`@lunora/codegen` exposes `mapSchema()` to build the map straight from the feeder. Full design, weights, and the divergences from `evlog map` are in [`docs/observability-map.md`](./docs/observability-map.md).

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/addons/studio)**.

## Related

- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — the `defineSchema` / `defineTable` schema these lints analyze.
- [`@lunora/codegen`](https://www.npmjs.com/package/@lunora/codegen) — runs the static lints at codegen time and returns them on `CodegenResult.advisories`.
- [`@lunora/studio`](https://www.npmjs.com/package/@lunora/studio) — renders the findings in the Advisors view.

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

The Lunora advisor package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/advisor?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/advisor
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/advisor?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/advisor
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
