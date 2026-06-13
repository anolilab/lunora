<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="testing" />

</a>

<h3 align="center">Testing toolkit for Cirrus: an in-memory harness for queries, mutations, and actions</h3>

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

Testing toolkit for Cirrus: an in-memory harness for queries, mutations, and actions. Today it surfaces the dev mail-catcher helpers — in `cirrus dev`, `@cirrus/mail` captures every outbound email into the studio's root-shard inbox, and these helpers read that inbox over the admin RPC so a Playwright (or any HTTP) test can drive "request reset → read the email → follow the link" deterministically.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @cirrus/testing
```

```sh
yarn add @cirrus/testing
```

```sh
pnpm add @cirrus/testing
```

## Usage

### In-memory function harness

`cirrusTest(schema)` runs your `query` / `mutation` / `action` functions against
an in-memory `node:sqlite` backend — no Durable Object, no `wrangler`, no
network. It mirrors Convex's `convexTest`: `query` / `mutation` / `action` /
`run` / `withIdentity`, all sharing one database so a write is visible to a
later read.

```ts
import { mutation, query, v } from "@cirrus/server";
import { cirrusTest } from "@cirrus/testing";
import { expect, test } from "vitest";

import schema from "./schema";

const send = mutation({
    args: { author: v.string(), body: v.string() },
    handler: (ctx, args) => ctx.db.insert("messages", args),
});

const list = query({
    args: {},
    handler: (ctx) => ctx.db.query("messages").collect(),
});

test("sends and lists a message", async () => {
    const t = cirrusTest(schema);

    await t.mutation(send, { author: "ada", body: "hi" });

    expect(await t.query(list, {})).toHaveLength(1);
});

test("sees the injected identity", async () => {
    const t = cirrusTest(schema).withIdentity({ userId: "u1" });

    await t.run(async (ctx) => {
        expect(ctx.auth.userId).toBe("u1");
    });
});
```

Each `cirrusTest(...)` opens an in-memory SQLite database; call `t.close()`
(e.g. in an `afterEach`) to release the native handle when a test finishes.

> **v1 scope.** `ctx.storage`, `ctx.scheduler`, `ctx.vectors`, and an action's
> `ctx.fetch` are clearly-throwing stubs — a handler that touches one fails with
> a "not available in the in-memory @cirrus/testing harness (v1)" error. HTTP
> actions, scheduled-function draining, real R2 storage, `.global()`/D1 tables,
> and Vectorize are deferred to a follow-up.

### Mail-catcher helpers (E2E)

```ts
import { extractLink, waitForMail } from "@cirrus/testing";

// Trigger the flow (e.g. POST /api/auth/forgot-password), then:
const mail = await waitForMail({
    adminToken: process.env.CIRRUS_ADMIN_TOKEN!,
    baseUrl: "http://localhost:8787",
    to: "alice@example.test",
    subjectMatch: "Reset your password",
});

const resetLink = extractLink(mail, { match: "/reset-password" });
// → visit `resetLink`, set a new password, assert success.
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://cirrus.dev/docs)**.

## Related

- [`@cirrus/mail`](https://www.npmjs.com/package/@cirrus/mail) — captures the outbound email these helpers read.
- [`@cirrus/auth`](https://www.npmjs.com/package/@cirrus/auth) — the auth flows (verification, reset, magic links) you test end-to-end.
- [`@cirrus/cli`](https://www.npmjs.com/package/@cirrus/cli) — runs the `cirrus dev` server the harness drives.

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

The Cirrus testing package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/cirrus/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@cirrus/testing?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@cirrus/testing
[npm-downloads-badge]: https://img.shields.io/npm/dm/@cirrus/testing?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@cirrus/testing
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
