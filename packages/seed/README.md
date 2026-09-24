<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="seed" />

</a>

<h3 align="center">Schema-driven, deterministic database seeding for Lunora: realistic fake data from defineSchema</h3>

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

`@lunora/seed` populates a Lunora database with realistic, production-like fake data derived from your `defineSchema`. It introspects every table, maps each field to a generator (field-name aware — a `string` column called `email` becomes an email address, `firstName` a first name, and so on), resolves foreign keys by inserting parent tables before their children, and lets you override any value.

Generated addresses always sit on the RFC 2606 reserved domain `example.com`, which accepts no mail — a seeded row can never turn into real email to a real stranger when a welcome job, a digest or an auth verification runs over it. Override the column when you need a domain of your own.

Generation is **deterministic**: it is built on a vendored, input-hashed generator (a rebuilt [`copycat`](https://github.com/supabase-community/copycat)) layered over [`@faker-js/faker`](https://fakerjs.dev). Generation is deterministic in `seed` alone for every column except the time-valued ones: a `number` column named like a timestamp (`createdAt`, `expiresAt`, …) is generated relative to the wall clock, so two runs with the same `seed` differ unless you also pin `now` (`--now` on the CLI). Ids are unaffected. Pin the `(seed, now)` pair and a plan is byte-identical across runs and machines.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/seed
```

```sh
yarn add @lunora/seed
```

```sh
pnpm add @lunora/seed
```

## Usage

### Generate a plan

```ts
import { seedPlan } from "@lunora/seed";
import schema from "./lunora/schema";

const plan = seedPlan(schema, {
    counts: { users: 10, posts: 30 },
    seed: 1,
    overrides: {
        users: { email: (ctx) => `user${ctx.index}@example.com` },
    },
});

// plan === [{ table: "users", rows: [...] }, { table: "posts", rows: [...] }]
// (parents before children; every post.authorId points at a generated user)
```

### Seed an in-memory test harness

```ts
import { lunoraTest } from "@lunora/testing";
import { seed } from "@lunora/seed/testing";
import schema from "./lunora/schema";

const harness = lunoraTest(schema);
const ids = await seed(harness, schema, { counts: { users: 5, posts: 20 } });
// ids.users / ids.posts — the inserted document ids, for assertions
```

### Typed client

For a Snaplet-style, one-table-at-a-time DX, `createSeedClient` exposes each table as a method. Foreign keys connect to whatever was seeded earlier in the run, FK parents are pulled in automatically, and state accumulates on `$store`/`$ids` (clear it with `$reset()`):

```ts
import { createSeedClient } from "@lunora/seed";
import schema from "./lunora/schema";

const seed = createSeedClient(schema, { seed: 1 });

const { users } = await seed.users(5);
const { posts } = await seed.posts((x) => x([10, 20])); // a deterministic count in [10, 20]

// Explicit partial rows — omitted columns are still generated:
await seed.users([{ name: "Alice" }, { email: "bob@example.com", name: "Bob" }]);

seed.$ids.users; // every user id generated this run
```

Pass your generated `InsertModel` type — `createSeedClient<InsertModel>(schema)` — for autocomplete on each table's columns. Or skip the wiring: when `@lunora/seed` is a declared dependency, codegen emits `_generated/seed.ts` with the schema and `InsertModel` already bound.

```ts
import { createSeedClient } from "@/lunora/_generated/seed";

const seed = createSeedClient({ seed: 1 });
const { users } = await seed.users(5); // columns typed from InsertModel
```

Supply a `persist` hook (`SeedClientOptions.persist`) to write each batch as it is generated (parents first); the client is pure when it is omitted. Per-call field overrides go in the second argument: `seed.posts(3, { overrides: { title: (ctx) => `Post ${ctx.index}` } })`.

### Seed a running dev worker

```bash
lunora seed --count 25                  # 25 rows per table (default 10)
lunora seed --table posts --count 100   # one table (FK parents seeded automatically)
lunora seed --seed 42 --now 1750000000000  # byte-identical run (pin both)
lunora seed --reset                      # wipe local .wrangler/state first (local dev only)
lunora seed --dry-run                    # print NDJSON, write nothing
```

Also: `--batch-size` (rows per HTTP request, default 500), `--url` (worker URL, default `http://localhost:8787`), `--prod` (requires an explicit `--url`), `--token` / `LUNORA_ADMIN_TOKEN` (admin bearer; prefer the env var), `--yes` (skip the non-local confirmation prompt). `--reset` is local-only and cannot be combined with `--prod` or a remote `--url`.

## Limitations

- **`.unique()` columns are dealt distinct values by construction.** Each value is a function of the row's absolute index, not a hash of the row, so two rows in the same run never collide — including across the several calls `indexOffset` exists to support. A column whose domain is too small to cover the requested count (a boolean, a three-literal `v.union()`) is refused at plan time, with the column named, before anything is inserted.
- **Seeding is deterministic by design.** Re-running with the same `--seed` regenerates identical `_id`s, which the import path skips as conflicts. Use a different `--seed` for fresh rows, or `--reset` to wipe local state first.

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/packages/seed)**.

## Related

- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — defines the `defineSchema` that seeding introspects.
- [`@lunora/testing`](https://www.npmjs.com/package/@lunora/testing) — the in-memory harness `@lunora/seed/testing` seeds.
- [`@lunora/cli`](https://www.npmjs.com/package/@lunora/cli) — ships the `lunora seed` command.

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

The Lunora seed package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/seed?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/seed
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/seed?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/seed
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
