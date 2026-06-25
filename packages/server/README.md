<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="server" />

</a>

<h3 align="center">Server primitives for Lunora: defineSchema, defineTable, query, mutation, and action</h3>

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

The server-side primitives you import inside `lunora/schema.ts`. It provides `defineSchema` / `defineTable`, `initLunora`, the `QueryCtx` / `MutationCtx` / `ActionCtx` shapes your handlers receive, and the RLS, HTTP, migration, and plugin authoring APIs. It also re-exports the [`v` validator suite](https://www.npmjs.com/package/@lunora/values) so you only need one import.

The `query` / `mutation` / `action` builders are **not** imported from here — codegen binds them to your schema's data model and re-exports them from `@/lunora/_generated/server`. Import them from there in your function files (see Usage).

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/server
```

```sh
yarn add @lunora/server
```

```sh
pnpm add @lunora/server
```

## Usage

Define your schema with `defineSchema` / `defineTable` / `v` from this package:

```ts
// lunora/schema.ts
import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    messages: defineTable({
        room: v.string(),
        body: v.string(),
        ts: v.number(),
    }).index("by_room_ts", ["room", "ts"]),
});
```

Write functions with the `query` / `mutation` / `action` builders codegen emits into `@/lunora/_generated/server` (import `v` from there too — its `v.id(...)` is narrowed to your real table names):

```ts
// lunora/messages.ts
import { mutation, query, v } from "@/lunora/_generated/server";

export const list = query.input({ room: v.string() }).query(({ args: { room }, ctx }) =>
    ctx.db
        .query("messages")
        .withIndex("by_room_ts", (q) => q.eq("room", room))
        .take(50),
);

export const send = mutation
    .input({ room: v.string(), body: v.string(), ts: v.number() })
    .mutation(({ args: { room, body, ts }, ctx }) => ctx.db.insert("messages", { room, body, ts }));
```

The builder chain is `<builder>.input(validators).<kind>(handler)`, plus `.use(middleware)` and `.output(validator)`. `internalQuery` / `internalMutation` / `internalAction` are the same builders but kept off the public `api`. Run `lunora codegen` (or the Vite plugin) to (re)generate `_generated/` after a schema change.

> **Determinism:** `query` and `mutation` handlers must be deterministic — they may be re-run on OCC retry or subscription re-evaluation. Read the current time from **`ctx.now`** (epoch ms, captured once per execution — also on `ActionCtx`) instead of `Date.now()`; compute randomness and network results in an `action` (`crypto.randomUUID()`, `fetch`) and pass them into the mutation as arguments. The `nondeterministic_query_mutation` advisor flags `Date.now()`/`Math.random()`/`fetch` in query/mutation handlers.

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/packages/server)**.

## Related

- [`@lunora/values`](https://www.npmjs.com/package/@lunora/values) — the `v.*` validators re-exported here.
- [`@lunora/runtime`](https://www.npmjs.com/package/@lunora/runtime) — the Worker runtime that executes your functions.
- [`@lunora/codegen`](https://www.npmjs.com/package/@lunora/codegen) — emits the typed `api` and data model from your schema.

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

The Lunora server package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/server?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/server
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/server?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/server
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
