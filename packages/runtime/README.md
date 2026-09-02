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

### Workers Cache

When `cache: { enabled: true }` is present in `wrangler.jsonc` and `compatibility_date >= "2026-05-01"`, the runtime forwards the Worker's `ExecutionContext.cache` into the **HTTP action** context as `ctx.cache`. This lets you purge cache by tag from an `httpRouter()` handler:

```ts
app.post(
    "/admin/refresh-products",
    httpAction(async (ctx) => {
        if (!ctx.cache) {
            return new Response("Workers Cache is not enabled in wrangler.jsonc", { status: 501 });
        }

        await ctx.cache.purge({ tags: ["products"] });

        return Response.json({ ok: true });
    }),
);
```

The `ctx.cache` binding reaches **HTTP action handlers only**. Queries, mutations, and RPC actions all run inside the Durable Object, which has no cache binding, so `ctx.cache` is `undefined` for every one of them — always branch on it. Cache header declarations on `httpRoute` (`.cacheControl()`, `.cacheTag()`, `.vary()`) are attached by `@lunora/server` before the response leaves the handler.

### Scheduled backups

The worker can take its own NDJSON snapshots on a Cron Trigger, writing them to an R2 bucket in your account — the same format and key layout `lunora backup list|restore` reads, so cron-written and hand-taken snapshots share one history.

```ts
interface BackupEnv extends Env {
    BACKUPS: R2Bucket;
    LUNORA_ADMIN_TOKEN: string;
}

let worker: LunoraWorker | null = null;

const build = (env: BackupEnv): LunoraWorker =>
    (worker ??= createWorker({
        adminToken: env.LUNORA_ADMIN_TOKEN,
        backupCron: "0 3 * * *", // must match an entry in wrangler `triggers.crons`, verbatim
        backupRetain: 14,
        backupStore: env.BACKUPS, // a bound R2 bucket satisfies `BackupStore`
        queryCoordinator, // the export walks every shard through it
        shardDO: env.SHARD,
    }));

export default {
    fetch: (request: Request, env: BackupEnv, ctx: ExecutionContext) => build(env).fetch(request, env, ctx),
    scheduled: (controller: ScheduledController, env: BackupEnv, ctx: ExecutionContext) => build(env).scheduled(controller, env, ctx),
};
```

Five things are easy to get wrong, and four of them fail silently:

- **`scheduled` must be wired.** `createWorker` returns it, but a worker that only exports `fetch` never runs a backup, and nothing reports that.
- **`backupCron` is compared verbatim** against the firing expression. `"0 3 * * *"` and `"0  3 * * *"` are different strings, and the mismatch is silent — the trigger fires, no backup runs.
- **`backupStore`, `adminToken` and `queryCoordinator` are all required.** The snapshot is assembled by walking every shard's admin export route, so it needs the coordinator to reach them and a token to authorize itself. Missing any one throws `BACKUP_NOT_CONFIGURED` from inside the scheduled handler — the one failure here that is loud.
- **`backupRetain` does not delete anything.** It is a reporting window: each run logs how many snapshots sit past the newest N and tells you to run `lunora backup prune`, which is the only thing that removes a backup. A bucket therefore grows until you prune it.
- **The snapshot is built in memory.** It is capped at 24 MiB and refuses past it, writing nothing — narrow it with `backupTables`, or take that snapshot off-platform with `lunora backup create --bucket`.

`backupPrefix` (default `"backups/"`) sets the key prefix, and `backupTables` narrows the snapshot to an allowlist. The 24 MiB cap is smaller than the 32 MiB one on `lunora backup create --bucket`, which travels through the checksum-verified upload route instead of being held in an isolate.

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
