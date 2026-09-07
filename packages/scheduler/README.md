<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="scheduler" />

</a>

<h3 align="center">Scheduling for Lunora: runAfter / runAt and Cron Triggers via SchedulerDO</h3>

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

Scheduling for Lunora. Defer function invocations with `runAfter` / `runAt` backed by a `SchedulerDO` Durable Object alarm, and run repeating jobs via Cloudflare Cron Triggers.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/scheduler
```

```sh
yarn add @lunora/scheduler
```

```sh
pnpm add @lunora/scheduler
```

Most apps schedule jobs through `ctx.scheduler` inside a mutation or action —
codegen wires that surface for you. Reach for the package exports directly when
you build the scheduler outside a function (a standalone Worker, a test), or
when you declare cron jobs.

## Usage

`ctx.scheduler` from a mutation or action — pass the function path as a string:

```ts
import { mutation, v } from "@/lunora/_generated/server";

export const requestReminder = mutation.input({ userId: v.id("users") }).mutation(async ({ ctx, args: { userId } }) => {
    // Run in 5 minutes.
    await ctx.scheduler.runAfter(5 * 60_000, "email:sendReminder", { userId });

    // Run at a specific moment.
    await ctx.scheduler.runAt(Date.now() + 60_000, "cleanup:run", { older: 30 });
});
```

Outside a function, build the scheduler yourself. The standalone `createScheduler`
takes a typed function reference instead of a path:

```ts
import { createScheduler } from "@lunora/scheduler";

import { api } from "@/lunora/_generated/api";

const scheduler = createScheduler({ namespace: env.SCHEDULER });

const id = await scheduler.runAfter(5 * 60_000, api.email.sendReminder, { userId: "u-1" });
await scheduler.cancel(id);
```

Declare recurring jobs in `lunora/crons.ts` — codegen lifts them into
`wrangler.jsonc` and the runtime's `scheduled()` handler:

```ts
import { cronJobs } from "@lunora/scheduler";

import { internal } from "@/lunora/_generated/api";

const crons = cronJobs();

crons.interval("clear presence", { minutes: 30 }, internal.presence.clear, {});
crons.hourly("sweep sessions", { minuteUTC: 17 }, internal.presence.sweep, {});
crons.daily("send digest", { hourUTC: 9, minuteUTC: 0 }, internal.email.digest, {});

export default crons;
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/packages/scheduler)**.

## Related

- [`@lunora/do`](https://www.npmjs.com/package/@lunora/do) — the Durable Objects the scheduler dispatches into.
- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — define the functions you schedule.
- [`@lunora/codegen`](https://www.npmjs.com/package/@lunora/codegen) — keeps `triggers.crons` in sync from your `cronJobs()` definitions.

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

The Lunora scheduler package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/scheduler?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/scheduler
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/scheduler?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/scheduler
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
