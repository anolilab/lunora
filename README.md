<div align="center">

<img src="./apps/docs/public/cirrus-lockup.svg" alt="Cirrus" width="360" />

**Type-safe real-time backend on your own Cloudflare account. Vite-first.**

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE.md)
[![Status: alpha](https://img.shields.io/badge/status-v0.1--alpha-blueviolet.svg)](#status)
[![Node](https://img.shields.io/badge/node-%5E22.14%20%7C%7C%20%3E%3D24.10-brightgreen.svg)](./.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-10.32.1-f69220.svg)](./package.json)
[![CI](https://github.com/anolilab/cirrus/actions/workflows/test.yml/badge.svg?branch=alpha)](https://github.com/anolilab/cirrus/actions/workflows/test.yml)
[![@cirrus/cli](https://img.shields.io/npm/v/@cirrus/cli?label=%40cirrus%2Fcli)](https://www.npmjs.com/package/@cirrus/cli)

</div>

---

## What is Cirrus?

Cirrus is **Convex DX on your own Cloudflare account**. You write type-safe queries, mutations, and actions in TypeScript; Cirrus turns them into Cloudflare Workers backed by Durable Objects for real-time state, D1 for SQL, R2 for blobs, and Queues for jobs. There are no proprietary servers in the loop — only the Cloudflare account you already pay for.

It is **Vite-first**: the dev loop, codegen, and client bindings plug into a Vite project via `@cloudflare/vite-plugin`, so dev runs on workerd (the same runtime as production). A standalone CLI fallback exists for non-Vite users.

## Quick start

```bash
pnpm dlx @cirrus/cli init my-app
cd my-app
pnpm dev
```

Three visible files in a fresh app:

```ts
// convex/schema.ts
import { defineSchema, defineTable, v } from "@cirrus/server";

export default defineSchema({
    messages: defineTable({
        author: v.string(),
        body: v.string(),
        ts: v.number(),
    }),
});
```

```ts
// convex/messages.ts
import { query, mutation, v } from "@cirrus/server";

export const list = query({
    args: {},
    handler: async (ctx) => ctx.db.query("messages").order("desc").take(50),
});

export const send = mutation({
    args: { body: v.string(), author: v.string() },
    handler: async (ctx, { body, author }) => {
        await ctx.db.insert("messages", { body, author, ts: Date.now() });
    },
});
```

```tsx
// src/App.tsx
import { useQuery, useMutation } from "@cirrus/react";
import { api } from "../convex/_generated/api";

export default function App() {
    const messages = useQuery(api.messages.list) ?? [];
    const send = useMutation(api.messages.send);
    return (
        <ul>
            {messages.map((m) => (
                <li key={m._id}>
                    {m.author}: {m.body}
                </li>
            ))}
        </ul>
    );
}
```

`pnpm dev` boots workerd, generates the client types, opens the Vite dev server, and live-reloads on every save.

## Why Cirrus

- **End-to-end type safety.** Server schema, validators, query results, and React hooks all share one source of truth. No client codegen step you forget to re-run.
- **Real-time by default.** Queries are reactive over WebSocket subscriptions; mutations push deltas to subscribed clients without manual cache invalidation.
- **Your data, your account.** Everything runs on your Cloudflare resources (Workers, Durable Objects, D1, R2, Queues, KV). No vendor lock-in beyond Cloudflare itself.
- **Scales past the single-DO ceiling.** Start simple with one Durable Object; opt into `.shardBy(key)` per function when you need tenant-level isolation, or `.global()` for geo-replicated reads, without rewriting your app.

## Cirrus vs. the alternatives

|                                                  | **Cirrus**             | Convex            | Zeroback         | Plain Cloudflare |
| ------------------------------------------------ | ---------------------- | ----------------- | ---------------- | ---------------- |
| Type-safe end-to-end                             | Yes                    | Yes               | Partial          | DIY              |
| Real-time subscriptions                          | Yes (WS, reactive)     | Yes               | Yes (single DO)  | DIY              |
| Runs on your account                             | **Yes (Cloudflare)**   | No (managed SaaS) | Yes (Cloudflare) | Yes              |
| Scales past single DO                            | **Yes (`.shardBy()`)** | n/a               | No               | DIY (manual)     |
| Vite-first DX                                    | **Yes**                | n/a               | Partial          | DIY              |
| Feature breadth (auth, mail, storage, scheduler) | Add-ons (alpha)        | Broad (built-in)  | Narrow           | DIY              |
| Cost at idle                                     | ≈ $0 (CF free tier)    | Paid              | ≈ $0             | ≈ $0             |
| Maturity                                         | **v0.1-alpha**         | Production        | Beta             | Stable runtime   |

Cirrus has fewer batteries-included features than Convex today. The trade you make is **infrastructure ownership and cost** — at idle, Cirrus is free; at scale, you pay Cloudflare prices, not SaaS prices.

## Architecture

```
                        ┌────────────────────────────────────┐
                        │  Browser / Node / RN client        │
                        │  @cirrus/client · @cirrus/react    │
                        └─────────────────┬──────────────────┘
                                          │  HTTPS + WebSocket (RPC envelope)
                                          ▼
                        ┌────────────────────────────────────┐
                        │  Vite dev (workerd)  or  Standalone │
                        │  @cirrus/vite        │  @cirrus/cli │
                        └─────────────────┬──────────────────┘
                                          │
                                          ▼
                ┌─────────────────────────────────────────────────┐
                │  Cloudflare Worker — @cirrus/runtime            │
                │  · parses RPC      · auth      · routing        │
                │  · upgrades WS to ShardDO via idFromName(key)   │
                └───┬──────────┬───────────┬───────────┬──────────┘
                    │          │           │           │
                    ▼          ▼           ▼           ▼
                ┌───────┐  ┌────────┐  ┌──────┐  ┌──────────┐
                │ Shard │  │Session │  │  D1  │  │R2/Queues │
                │  DO   │  │  DO    │  │ SQL  │  │   KV     │
                │(state)│  │ (auth) │  │      │  │          │
                └───────┘  └────────┘  └──────┘  └──────────┘
                  │
                  └── SQLite-backed, WebSocket Hibernation API,
                      subscription registry
```

## Packages

All packages are published under the [`@cirrus`](https://www.npmjs.com/org/cirrus) npm scope and live under `packages/`.

| Package                                             | What it does                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`@cirrus/server`](./packages/cirrus-server/)       | `defineSchema`, `query`, `mutation`, `action` — the Convex-style function API.     |
| [`@cirrus/runtime`](./packages/cirrus-runtime/)     | Worker entry layer. Parses the RPC envelope, resolves shards, mounts HTTP routes.  |
| [`@cirrus/do`](./packages/cirrus-do/)               | `ShardDO` + `SessionDO` base classes (SQLite + WebSocket Hibernation API).         |
| [`@cirrus/d1`](./packages/cirrus-d1/)               | D1 adapter with per-request Sessions API and a sequential migration runner.        |
| [`@cirrus/client`](./packages/cirrus-client/)       | Framework-agnostic client: reactive queries, offline queue, reconnect.             |
| [`@cirrus/react`](./packages/cirrus-react/)         | React bindings: `<CirrusProvider>`, `useQuery`, `useMutation`, `useSubscription`.  |
| [`@cirrus/values`](./packages/cirrus-values/)       | The `v.*` validator builder + `ValidationError`. Pure, dependency-free.            |
| [`@cirrus/codegen`](./packages/cirrus-codegen/)     | Discovers your `schema.ts` + functions, emits `_generated/api.ts` and friends.     |
| [`@cirrus/vite`](./packages/cirrus-vite/)           | Vite plugin: codegen, wrangler validation, error overlay, workerd dev integration. |
| [`@cirrus/cli`](./packages/cirrus-cli/)             | `init`, `dev`, `deploy`, `run`, `reset`, `codegen` — the standalone CLI.           |
| [`@cirrus/config`](./packages/cirrus-config/)       | Wrangler config validator (compatibility date, required flags, schema info).       |
| [`@cirrus/auth`](./packages/cirrus-auth/)           | Cookie-session auth: email/password + OAuth (PKCE) scaffolding, D1-backed.         |
| [`@cirrus/mail`](./packages/cirrus-mail/)           | Transactional email via `@visulima/email` (Resend by default, others swappable).   |
| [`@cirrus/storage`](./packages/cirrus-storage/)     | R2 file storage adapter with worker-signed URLs.                                   |
| [`@cirrus/scheduler`](./packages/cirrus-scheduler/) | Delayed and scheduled function invocation (Queues-backed).                         |

## Status

**v0.1-alpha — APIs WILL break.** This is bootstrap-quality. Nothing is on npm yet; the surface area, package boundaries, and on-disk layout will all shift before the first non-alpha tag.

You are welcome to read, file issues, and open PRs against the [`alpha`](https://github.com/anolilab/cirrus/tree/alpha) branch. Just don't build a production system on it yet.

## Contributing

See [`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md). The default branch is **`alpha`**; PRs target `alpha` unless explicitly cutting a release.

For security reports, see [`SECURITY.md`](./SECURITY.md). For community guidelines, see [`.github/CODE_OF_CONDUCT.md`](./.github/CODE_OF_CONDUCT.md). For brand assets and usage rules, see [`BRAND.md`](./BRAND.md).

## License

[MIT](./LICENSE.md) © 2026 Daniel Bannert and contributors.
