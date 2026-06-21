<div align="center">

<img src="./apps/docs/public/lunora-lockup.svg" alt="Lunora" width="360" />

**Type-safe real-time backend on your own Cloudflare account. Vite-first.**

[![License: FSL-1.1-Apache-2.0](https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg)](./LICENSE.md)
[![Status: alpha](https://img.shields.io/badge/status-v1.0.0--alpha.1-blueviolet.svg)](#status)
[![Node](https://img.shields.io/badge/node-%5E22.14%20%7C%7C%20%3E%3D24.10-brightgreen.svg)](./.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-11.5.3-f69220.svg)](./package.json)
[![CI](https://github.com/anolilab/lunora/actions/workflows/test.yml/badge.svg?branch=alpha)](https://github.com/anolilab/lunora/actions/workflows/test.yml)
[![@lunora/cli](https://img.shields.io/npm/v/@lunora/cli?label=%40lunora%2Fcli)](https://www.npmjs.com/package/@lunora/cli)

</div>

---

## What is Lunora?

Lunora is **Convex DX on your own Cloudflare account**. You write type-safe queries, mutations, and actions in TypeScript; Lunora turns them into Cloudflare Workers backed by Durable Objects for real-time state, D1 for SQL, R2 for blobs, and Queues for jobs. There are no proprietary servers in the loop — only the Cloudflare account you already pay for.

It is **Vite-first**: the dev loop, codegen, and client bindings plug into a Vite project via `@cloudflare/vite-plugin`, so dev runs on workerd (the same runtime as production). A standalone CLI fallback exists for non-Vite users.

## Quick start

```bash
pnpm dlx lunorash init my-app
cd my-app
pnpm dev
```

Three visible files in a fresh app:

```ts
// lunora/schema.ts
import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    messages: defineTable({
        author: v.string(),
        body: v.string(),
        ts: v.number(),
    }),
});
```

```ts
// lunora/messages.ts
import { mutation, query, v } from "./_generated/server";

export const list = query.query(async ({ ctx }) => ctx.db.query("messages").order("desc").take(50));

export const send = mutation.input({ author: v.string(), body: v.string() }).mutation(async ({ ctx, args }) => {
    await ctx.db.insert("messages", { ...args, ts: Date.now() });
});
```

```tsx
// src/App.tsx
import { useQuery, useMutation } from "@lunora/react";
import { api } from "../lunora/_generated/api";

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

## Why Lunora

- **End-to-end type safety.** Server schema, validators, query results, and React hooks all share one source of truth. No client codegen step you forget to re-run.
- **Real-time by default.** Queries are reactive over WebSocket subscriptions; mutations push deltas to subscribed clients without manual cache invalidation.
- **Your data, your account.** Everything runs on your Cloudflare resources (Workers, Durable Objects, D1, R2, Queues, KV). No vendor lock-in beyond Cloudflare itself.
- **Scales past the single-DO ceiling.** Start simple with one Durable Object; opt into `.shardBy(key)` per function when you need tenant-level isolation, or `.global()` for geo-replicated reads, without rewriting your app.

## Lunora vs. the alternatives

|                                                  | **Lunora**             | Convex            | Firebase          | Plain Cloudflare |
| ------------------------------------------------ | ---------------------- | ----------------- | ----------------- | ---------------- |
| Type-safe end-to-end                             | Yes                    | Yes               | Partial           | DIY              |
| Real-time subscriptions                          | Yes (WS, reactive)     | Yes               | Yes               | DIY              |
| Runs on your account                             | **Yes (Cloudflare)**   | No (managed SaaS) | No (managed SaaS) | Yes              |
| Scales past single DO                            | **Yes (`.shardBy()`)** | n/a               | n/a               | DIY (manual)     |
| Vite-first DX                                    | **Yes**                | n/a               | n/a               | DIY              |
| Feature breadth (auth, mail, storage, scheduler) | Add-ons (alpha)        | Broad (built-in)  | Broad (built-in)  | DIY              |
| Cost at idle                                     | ≈ $0 (CF free tier)    | Paid              | ≈ $0 (Spark tier) | ≈ $0             |

Lunora has fewer batteries-included features than Convex today. The trade you make is **infrastructure ownership and cost** — at idle, Lunora is free; at scale, you pay Cloudflare prices, not SaaS prices.

## Architecture

```
                        ┌────────────────────────────────────┐
                        │  Browser / Node / RN client        │
                        │  @lunora/client · @lunora/react    │
                        └─────────────────┬──────────────────┘
                                          │  HTTPS + WebSocket (RPC envelope)
                                          ▼
                        ┌────────────────────────────────────┐
                        │  Vite dev (workerd)  or  Standalone │
                        │  @lunora/vite        │  @lunora/cli │
                        └─────────────────┬──────────────────┘
                                          │
                                          ▼
                ┌─────────────────────────────────────────────────┐
                │  Cloudflare Worker — @lunora/runtime            │
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

All packages are published under the [`@lunora`](https://www.npmjs.com/org/lunora) npm scope and live under `packages/`.

| Package                                      | What it does                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`@lunora/server`](./packages/server/)       | `defineSchema`, `query`, `mutation`, `action` — the typed, chainable function API. |
| [`@lunora/runtime`](./packages/runtime/)     | Worker entry layer. Parses the RPC envelope, resolves shards, mounts HTTP routes.  |
| [`@lunora/do`](./packages/do/)               | `ShardDO` + `SessionDO` base classes (SQLite + WebSocket Hibernation API).         |
| [`@lunora/d1`](./packages/d1/)               | D1 adapter with per-request Sessions API and a sequential migration runner.        |
| [`@lunora/client`](./packages/client/)       | Framework-agnostic client: reactive queries, offline queue, reconnect.             |
| [`@lunora/react`](./packages/react/)         | React bindings: `<LunoraProvider>`, `useQuery`, `useMutation`, `useSubscription`.  |
| [`@lunora/values`](./packages/values/)       | The `v.*` validator builder + `ValidationError`. Pure, dependency-free.            |
| [`@lunora/codegen`](./packages/codegen/)     | Discovers your `schema.ts` + functions, emits `_generated/api.ts` and friends.     |
| [`@lunora/vite`](./packages/vite/)           | Vite plugin: codegen, wrangler validation, error overlay, workerd dev integration. |
| [`@lunora/cli`](./packages/cli/)             | `init`, `dev`, `deploy`, `run`, `reset`, `codegen` — the standalone CLI.           |
| [`@lunora/config`](./packages/config/)       | Wrangler config validator (compatibility date, required flags, schema info).       |
| [`@lunora/auth`](./packages/auth/)           | Cookie-session auth: email/password + OAuth (PKCE) scaffolding, D1-backed.         |
| [`@lunora/mail`](./packages/mail/)           | Transactional email via `@visulima/email` (Resend by default, others swappable).   |
| [`@lunora/storage`](./packages/storage/)     | R2 file storage adapter with worker-signed URLs.                                   |
| [`@lunora/scheduler`](./packages/scheduler/) | Delayed and scheduled function invocation (Queues-backed).                         |

## Status

**v1.0.0-alpha.1 — APIs WILL break.** This is bootstrap-quality. Nothing is on npm yet; the surface area, package boundaries, and on-disk layout will all shift before the first non-alpha tag.

You are welcome to read, file issues, and open PRs against the [`alpha`](https://github.com/anolilab/lunora/tree/alpha) branch. Just don't build a production system on it yet.

## Contributing

See [`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md). The default branch is **`alpha`**; PRs target `alpha` unless explicitly cutting a release.

For security reports, see [`SECURITY.md`](./SECURITY.md). For community guidelines, see [`.github/CODE_OF_CONDUCT.md`](./.github/CODE_OF_CONDUCT.md). For brand assets and usage rules, see [`marketing/BRAND.md`](./marketing/BRAND.md).

## License

[FSL-1.1-Apache-2.0](./LICENSE.md) © 2026 anolilab and contributors. Source-available; each release converts to Apache-2.0 two years after it ships.
