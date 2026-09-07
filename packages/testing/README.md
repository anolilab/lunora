<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="testing" />

</a>

<h3 align="center">Testing toolkit for Lunora: an in-memory harness for queries, mutations, and actions</h3>

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

Testing toolkit for Lunora: an in-memory harness for queries, mutations, and actions. Today it surfaces the dev mail-catcher helpers — in `lunora dev`, `@lunora/mail` captures every outbound email into the studio's root-shard inbox, and these helpers read that inbox over the admin RPC so a Playwright (or any HTTP) test can drive "request reset → read the email → follow the link" deterministically.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/testing
```

```sh
yarn add @lunora/testing
```

```sh
pnpm add @lunora/testing
```

## Usage

### In-memory function harness

`lunoraTest(schema)` runs your `query` / `mutation` / `action` functions against
an in-memory `node:sqlite` backend — no Durable Object, no `wrangler`, no
network. It mirrors Convex's `convexTest`: `query` / `mutation` / `action` /
`run` / `withIdentity`, all sharing one database so a write is visible to a
later read.

In your app, `query` / `mutation` / `action` are imported from
`@/lunora/_generated/server` — the codegen-emitted module. A self-contained test
can instead derive the builders from a schema with `initLunora`:

```ts
import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { lunoraTest } from "@lunora/testing";
import { expect, test } from "vitest";

const schema = defineSchema({
    messages: defineTable({
        author: v.string(),
        body: v.string(),
    }),
});

const { mutation, query } = initLunora.dataModel().create();

const send = mutation.input({ author: v.string(), body: v.string() }).mutation(({ args, ctx }) => ctx.db.insert("messages", args));

const list = query.query(({ ctx }) => ctx.db.query("messages").collect());

test("sends and lists a message", async () => {
    const t = lunoraTest(schema);

    await t.mutation(send, { author: "ada", body: "hi" });

    expect(await t.query(list, {})).toHaveLength(1);
});

test("sees the injected identity", async () => {
    const t = lunoraTest(schema).withIdentity({ userId: "u1" });

    await t.run(async (ctx) => {
        expect(ctx.auth.userId).toBe("u1");
    });
});
```

Each `lunoraTest(...)` opens an in-memory SQLite database; call `t.close()`
(e.g. in an `afterEach`) to release the native handle when a test finishes.

#### Injectable `ctx.fetch`

Pass a `fetch` option to replace the throwing stub in action contexts:

```ts
const fakeFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true }));
const t = lunoraTest(schema, { fetch: fakeFetch });
// ctx.fetch inside any action now calls fakeFetch
```

Without the option, `ctx.fetch` still throws the v1 error on first access.

#### Fixed `ctx.now`

Pass a `now` option (epoch ms) to pin `ctx.now` across every context, so
time-dependent handlers are deterministic:

```ts
const t = lunoraTest(schema, { now: 1_700_000_000_000 });
// ctx.now === 1_700_000_000_000 in every query/mutation/action
```

Defaults to the wall clock captured at harness creation.

#### Controllable in-memory scheduler

`ctx.scheduler` is a fully functional fake. Jobs are enqueued synchronously but
**only execute** when you advance the virtual clock:

```ts
// The mutation the scheduler will dispatch, registered under "messages:send".
const sendMessage = mutation.input({ author: v.string(), body: v.string() }).mutation(({ args, ctx }) => ctx.db.insert("messages", args));

// A mutation that schedules `sendMessage` 5s out instead of writing directly.
const enqueue = mutation.mutation(({ ctx }) => ctx.scheduler.runAfter(5_000, "messages:send", { author: "ada", body: "hello" }));

test("scheduled mutation writes to db after advance", async () => {
    const t = lunoraTest(schema, {
        functions: { "messages:send": sendMessage }, // path → registered fn
    });

    await t.mutation(enqueue, {});

    expect(t.scheduler.list()).toHaveLength(1); // queued, not yet run

    await t.scheduler.advance(10_000); // tick the clock past scheduledFor

    expect(await t.query(list, {})).toHaveLength(1); // sendMessage ran
});
```

Harness controls:

| Method                     | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `t.scheduler.list()`       | Snapshot of all pending jobs (enqueue order)          |
| `t.scheduler.advance(ms)`  | Tick the virtual clock by `ms`, execute due jobs      |
| `t.scheduler.runPending()` | Execute all pending jobs regardless of scheduled time |

The virtual clock is **per-harness** — advancing one harness's clock does not
affect other harnesses, so tests running in parallel are isolated.

Provide a `functions` map (`{ "path:name": registeredFn }`) so the scheduler
can dispatch jobs. A path not in the map fails the job with `FUNCTION_NOT_FOUND`,
which then walks the retry budget into `t.scheduler.failures()` — matching
production, where the DO fires the job at the Worker and dead-letters it.

A retryable failure is re-enqueued silently, so `failures()` only fills once the
whole backoff schedule (~930s of virtual clock) has elapsed — and at that point
`advance()`/`runPending()` re-throw the failure by default. Pass
`{ throwOnError: false }` to inspect `failures()` instead.

#### Subscription testing

`harness.subscribe(query, args)` returns an async iterable that yields the query's
current result immediately, then re-emits after every `mutation` or `run` call:

```ts
test("subscription re-emits after mutation", async () => {
    const t = lunoraTest(schema);
    const sub = t.subscribe(list, {});

    expect((await sub.next()).value).toHaveLength(0); // initial snapshot

    await t.mutation(send, { author: "ada", body: "hi" });

    expect((await sub.next()).value).toHaveLength(1); // updated snapshot

    await sub.return(); // unsubscribe
});
```

Subscriptions are **table-agnostic** — any mutation triggers a re-evaluation.
Multiple independent subscriptions each maintain their own snapshot stream.

> **v1 stubs (still throwing).** `ctx.storage`, `ctx.vectors`, and `ctx.workflows`
> are clearly-throwing stubs — a handler that touches one fails with a
> "not available in the in-memory @lunora/testing harness (v1)" error.
> These are the next planned follow-ups.

### Mail-catcher helpers (E2E)

```ts
import { extractLink, waitForMail } from "@lunora/testing";

// Trigger the flow (e.g. POST /api/auth/forgot-password), then:
const mail = await waitForMail({
    adminToken: process.env.LUNORA_ADMIN_TOKEN!,
    baseUrl: "http://localhost:8787",
    to: "alice@example.test",
    subjectMatch: "Reset your password",
});

const resetLink = extractLink(mail, { match: "/reset-password" });
// → visit `resetLink`, set a new password, assert success.
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs)**.

## Related

- [`@lunora/mail`](https://www.npmjs.com/package/@lunora/mail) — captures the outbound email these helpers read.
- [`@lunora/auth`](https://www.npmjs.com/package/@lunora/auth) — the auth flows (verification, reset, magic links) you test end-to-end.
- [`@lunora/cli`](https://www.npmjs.com/package/@lunora/cli) — runs the `lunora dev` server the harness drives.

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

The Lunora testing package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/testing?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/testing
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/testing?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/testing
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
