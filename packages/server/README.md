<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="server" />

</a>

<h3 align="center">Server primitives for Cirrus: defineSchema, defineTable, query, mutation, and action</h3>

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

The server-side primitives you import inside `cirrus/schema.ts` and your function files. It provides `defineSchema` / `defineTable`, the `query` / `mutation` / `action` wrappers, and the `QueryCtx` / `MutationCtx` / `ActionCtx` shapes your handlers receive. It also re-exports the [`v` validator suite](https://www.npmjs.com/package/@cirrus/values) so you only need one import.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @cirrus/server
```

```sh
yarn add @cirrus/server
```

```sh
pnpm add @cirrus/server
```

## Usage

```ts
import { defineSchema, defineTable, mutation, query, v } from "@cirrus/server";

// cirrus/schema.ts
export default defineSchema({
    messages: defineTable({
        room: v.string(),
        body: v.string(),
        ts: v.number(),
    }).index("by_room_ts", ["room", "ts"]),
});

// cirrus/messages.ts
export const list = query({
    args: { room: v.string() },
    handler: (ctx, { room }) =>
        ctx.db
            .query("messages")
            .withIndex("by_room_ts", (q) => q.eq("room", room))
            .take(50),
});

export const send = mutation({
    args: { room: v.string(), body: v.string() },
    handler: (ctx, { room, body }) => ctx.db.insert("messages", { room, body, ts: Date.now() }),
});
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://cirrus.dev/docs/api/server)**.

## Related

- [`@cirrus/values`](https://www.npmjs.com/package/@cirrus/values) — the `v.*` validators re-exported here.
- [`@cirrus/runtime`](https://www.npmjs.com/package/@cirrus/runtime) — the Worker runtime that executes your functions.
- [`@cirrus/codegen`](https://www.npmjs.com/package/@cirrus/codegen) — emits the typed `api` and data model from your schema.

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

The Cirrus server package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/cirrus/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@cirrus/server?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@cirrus/server
[npm-downloads-badge]: https://img.shields.io/npm/dm/@cirrus/server?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@cirrus/server
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
