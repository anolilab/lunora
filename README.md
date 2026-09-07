<div align="center">

<img src="./.github/assets/package-og.svg" alt="Lunora" />

**Type-safe, real-time backend on your own Cloudflare account. Vite-first.**

[**Documentation**](https://lunora.sh/docs) · [**Website**](https://lunora.sh) · [**Packages**](https://lunora.sh/packages) · [**Quick start**](#quick-start)

<br />

[![typescript-image][typescript-badge]][typescript-url]
[![FSL-1.1-Apache-2.0 licence][license-badge]][license]
[![Status][status-badge]][status]
[![Node][node-badge]][node]
[![pnpm][pnpm-badge]][pnpm]
[![CI][ci-badge]][ci]
[![npm version][npm-version-badge]][npm-version]
[![PRs Welcome][prs-welcome-badge]][prs-welcome]
[![OpenSSF Scorecard][scorecard-badge]][scorecard]

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

## What is Lunora?

Lunora is **Convex DX on your own Cloudflare account**. You write type-safe queries, mutations, and actions in TypeScript; Lunora turns them into Cloudflare Workers backed by Durable Objects for real-time state, D1 for SQL, R2 for blobs, and Queues for jobs. There are no proprietary servers in the loop — only the Cloudflare account you already pay for.

It is **Vite-first**: the dev loop, codegen, and client bindings plug into a Vite project via `@cloudflare/vite-plugin`, so dev runs on workerd (the same runtime as production). A standalone CLI fallback exists for non-Vite users.

## Quick start

```bash
pnpm dlx lunorash@alpha init my-app
cd my-app
pnpm install
pnpm dev
```

> **Alpha:** the npm package is **`lunorash`** (the unscoped `lunora` name is taken on npm); the CLI binary it installs is still **`lunora`**. Install from the `@alpha` dist-tag and expect breaking changes until the first stable release. `npm view <pkg> version` reports a `0.0.x` placeholder on `latest` for every Lunora package — the real version lives on the `alpha` dist-tag (`npm view <pkg> dist-tags`).

> Prefer managed hosting, or just want one email when v1 is stable? **[Join the Lunora Cloud waitlist →](https://lunora.sh/cloud)**

Three visible files in a fresh app:

```ts
// lunora/schema.ts
import { defineSchema, defineTable, v } from "lunorash/server";

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
- **Host-neutral core.** The reactive engine (`@lunora/shard-engine`) talks to a small set of host contracts (`@lunora/platform`) rather than to Cloudflare APIs directly; `@lunora/platform-cloudflare` is one implementation of them. A capability matrix records, per target, what is native, emulated, or unsupported.

## Lunora Studio

Every app ships with **Lunora Studio** — a local admin UI for your schema, data, functions, logs, and advisors, served automatically by `pnpm dev`. Browse and edit data, run SQL, inspect live connections and function metrics, replay state with Time Travel, and read the security & performance advisories generated from your schema.

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./.github/assets/studio-home-dark.png" />
    <img src="./.github/assets/studio-home-light.png" alt="Lunora Studio — the local admin UI for your schema, data, functions, and advisors" width="900" />
  </picture>
</div>

> Read the [Studio deep dive →](https://lunora.sh/blog/lunora-studio-deep-dive)

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
                  ├── SQLite-backed, WebSocket Hibernation API,
                  │   subscription registry
                  │
                  └── @lunora/shard-engine (host-neutral: state, OCC,
                      CDC, reactivity) over @lunora/platform contracts,
                      implemented for this target by
                      @lunora/platform-cloudflare
```

## Packages

All packages are published under the [`@lunora`](https://www.npmjs.com/org/lunora) npm scope (except the unscoped umbrella `lunorash`) and live under `packages/`.

> This table is generated from each package's `package.json` and `project.json`. Run `pnpm run generate:packages-list` to refresh it.

<!-- START_TABLE_PLACEHOLDER -->

### Runtime

| Package                                                 | Version                                                                                                                                                                        | Description                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@lunora/d1`](packages/d1/README.md)                   | [![npm](https://img.shields.io/npm/v/%40lunora%2Fd1?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fd1)                   | D1 adapter for Lunora .global() tables, wrapping the Sessions API for read-your-writes                                                                                  |
| [`@lunora/do`](packages/do/README.md)                   | [![npm](https://img.shields.io/npm/v/%40lunora%2Fdo?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fdo)                   | Lunora Durable Objects: ShardDO (SQLite, OCC, hibernated WebSocket subscriptions) and SessionDO                                                                         |
| [`@lunora/errors`](packages/errors/README.md)           | [![npm](https://img.shields.io/npm/v/%40lunora%2Ferrors?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Ferrors)           | Unified error layer for Lunora: one LunoraError base + a central catalog of codes, statuses, and actionable hints, rendered across CLI, overlay, Studio, and the client |
| [`@lunora/fingerprint`](packages/fingerprint/README.md) | [![npm](https://img.shields.io/npm/v/%40lunora%2Ffingerprint?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Ffingerprint) | Zero-dependency, cross-runtime error fingerprinting for Lunora: a stable grouping hash that collapses noisy errors into Issues across the local Studio and the Cloud    |
| [`@lunora/runtime`](packages/runtime/README.md)         | [![npm](https://img.shields.io/npm/v/%40lunora%2Fruntime?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fruntime)         | Lunora Worker runtime: the RPC router, shard resolver, and query coordinator                                                                                            |
| [`@lunora/server`](packages/server/README.md)           | [![npm](https://img.shields.io/npm/v/%40lunora%2Fserver?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fserver)           | Server primitives for Lunora: defineSchema, defineTable, query, mutation, and action                                                                                    |
| [`@lunora/sql-store`](packages/sql-store/README.md)     | [![npm](https://img.shields.io/npm/v/%40lunora%2Fsql-store?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fsql-store)     | Internal dialect-parameterized SQL store core for Lunora .global() backends (D1, PlanetScale)                                                                           |
| [`@lunora/values`](packages/values/README.md)           | [![npm](https://img.shields.io/npm/v/%40lunora%2Fvalues?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fvalues)           | Validators for Lunora: the v.* validator suite with end-to-end return-type inference                                                                                    |
| [`lunorash`](packages/lunora/README.md)                 | [![npm](https://img.shields.io/npm/v/lunorash?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/lunorash)                               | The Lunora umbrella package: one install for the server authoring API, worker runtime, Durable Objects, and the lunora CLI                                              |

### Client & Framework Adapters

| Package                                                   | Version                                                                                                                                                                          | Description                                                                                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@lunora/angular`](packages/angular/README.md)           | [![npm](https://img.shields.io/npm/v/%40lunora%2Fangular?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fangular)           | Angular reactive adapter for Lunora — signal-based live queries and mutations                                                                                             |
| [`@lunora/astro`](packages/astro/README.md)               | [![npm](https://img.shields.io/npm/v/%40lunora%2Fastro?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fastro)               | Astro integration for Lunora — single-worker composition plus reactive-loader server helpers                                                                              |
| [`@lunora/client`](packages/client/README.md)             | [![npm](https://img.shields.io/npm/v/%40lunora%2Fclient?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fclient)             | Lunora browser SDK: WebSocket transport, optimistic updates, and an offline mutation queue                                                                                |
| [`@lunora/db`](packages/db/README.md)                     | [![npm](https://img.shields.io/npm/v/%40lunora%2Fdb?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fdb)                     | TanStack DB binding: typed, live-synced collections and a durable offline outbox over the Lunora client                                                                   |
| [`@lunora/nuxt`](packages/nuxt/README.md)                 | [![npm](https://img.shields.io/npm/v/%40lunora%2Fnuxt?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fnuxt)                 | Nuxt module for Lunora — single-worker composition (mounts /_lunora/* into Nitro) plus reactive-loader server helpers                                                     |
| [`@lunora/react`](packages/react/README.md)               | [![npm](https://img.shields.io/npm/v/%40lunora%2Freact?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Freact)               | React hooks for Lunora: useQuery, useMutation, useSubscription, and useAuth                                                                                               |
| [`@lunora/react-native`](packages/react-native/README.md) | [![npm](https://img.shields.io/npm/v/%40lunora%2Freact-native?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Freact-native) | React Native / Expo integration for Lunora: an AsyncStorage-backed client factory, the useQuery/useMutation/useSubscription hooks, and a one-call better-auth Expo client |
| [`@lunora/solid`](packages/solid/README.md)               | [![npm](https://img.shields.io/npm/v/%40lunora%2Fsolid?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fsolid)               | SolidJS adapter for Lunora — live queries, optimistic mutations, and reactive loaders                                                                                     |
| [`@lunora/studio`](packages/studio/README.md)             | [![npm](https://img.shields.io/npm/v/%40lunora%2Fstudio?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fstudio)             | The Lunora Studio: a local admin UI for your schema, data, logs, and advisors                                                                                             |
| [`@lunora/svelte`](packages/svelte/README.md)             | [![npm](https://img.shields.io/npm/v/%40lunora%2Fsvelte?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fsvelte)             | Svelte adapter for Lunora — live stores, optimistic mutations, and reactive loaders                                                                                       |
| [`@lunora/vue`](packages/vue/README.md)                   | [![npm](https://img.shields.io/npm/v/%40lunora%2Fvue?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fvue)                   | Vue adapter for Lunora — live composables, optimistic mutations, and reactive loaders                                                                                     |

### CLI

| Package                                 | Version                                                                                                                                                        | Description                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [`@lunora/cli`](packages/cli/README.md) | [![npm](https://img.shields.io/npm/v/%40lunora%2Fcli?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fcli) | The Lunora CLI: init, dev, deploy, codegen, migrate, seed, doctor, insights, logs, registry, and the rest of the project commands |

### Codegen

| Package                                         | Version                                                                                                                                                                | Description                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`@lunora/codegen`](packages/codegen/README.md) | [![npm](https://img.shields.io/npm/v/%40lunora%2Fcodegen?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fcodegen) | Code generator for Lunora: emits _generated/{api,server,dataModel}.ts from your schema |

### Vite Plugin

| Package                                   | Version                                                                                                                                                          | Description                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`@lunora/vite`](packages/vite/README.md) | [![npm](https://img.shields.io/npm/v/%40lunora%2Fvite?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fvite) | The Lunora Vite plugin: codegen, type sync, wrangler validation, and an error overlay over @cloudflare/vite-plugin |

### Dev Tools

| Package                                         | Version                                                                                                                                                                | Description                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`@lunora/config`](packages/config/README.md)   | [![npm](https://img.shields.io/npm/v/%40lunora%2Fconfig?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fconfig)   | Internal shared CLI + Vite config layer for Lunora: wrangler.jsonc validation, binding inference, and .dev.vars scaffolding |
| [`@lunora/testing`](packages/testing/README.md) | [![npm](https://img.shields.io/npm/v/%40lunora%2Ftesting?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Ftesting) | Testing toolkit for Lunora: an in-memory harness for queries, mutations, and actions                                        |

### Advisor

| Package                                         | Version                                                                                                                                                                | Description                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`@lunora/advisor`](packages/advisor/README.md) | [![npm](https://img.shields.io/npm/v/%40lunora%2Fadvisor?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fadvisor) | Schema & query lints (splinter-style advisors) for Lunora, feeding the Studio Advisors view |

### Add-ons

| Package                                                             | Version                                                                                                                                                                                    | Description                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@lunora/agent`](packages/agent/README.md)                         | [![npm](https://img.shields.io/npm/v/%40lunora%2Fagent?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fagent)                         | Durable AI agents for Lunora: defineAgent compiles a replay-safe tool-loop onto Cloudflare Workflows, with DO SQLite threads and live message subscriptions                                                            |
| [`@lunora/ai`](packages/ai/README.md)                               | [![npm](https://img.shields.io/npm/v/%40lunora%2Fai?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fai)                               | Workers AI helper for Lunora: provider-agnostic AI SDK access from functions, Workers AI by default                                                                                                                    |
| [`@lunora/auth`](packages/auth/README.md)                           | [![npm](https://img.shields.io/npm/v/%40lunora%2Fauth?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fauth)                           | Auth for Lunora — a thin better-auth wrapper: email/password, OAuth, plugins, D1-backed                                                                                                                                |
| [`@lunora/bindings`](packages/bindings/README.md)                   | [![npm](https://img.shields.io/npm/v/%40lunora%2Fbindings?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fbindings)                   | Lightweight Cloudflare binding helpers for Lunora — ctx.kv, ctx.images, ctx.analytics, ctx.pipelines, ctx.vectors, ctx.r2sql — one install, per-binding subpaths                                                       |
| [`@lunora/browser`](packages/browser/README.md)                     | [![npm](https://img.shields.io/npm/v/%40lunora%2Fbrowser?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fbrowser)                     | Cloudflare Browser Rendering for Lunora: ctx.browser screenshots, PDF, and scraping in actions                                                                                                                         |
| [`@lunora/cloudflare-access`](packages/cloudflare-access/README.md) | [![npm](https://img.shields.io/npm/v/%40lunora%2Fcloudflare-access?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fcloudflare-access) | Cloudflare Access (Zero Trust) identity for Lunora — verify the Cf-Access-Jwt-Assertion JWT against your team JWKS and feed the verified identity into ctx.auth / RLS via a resolveIdentity adapter                    |
| [`@lunora/container`](packages/container/README.md)                 | [![npm](https://img.shields.io/npm/v/%40lunora%2Fcontainer?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fcontainer)                 | Cloudflare Containers for Lunora: defineContainer, generated Container DO classes, and the ctx.containers action surface                                                                                               |
| [`@lunora/flags`](packages/flags/README.md)                         | [![npm](https://img.shields.io/npm/v/%40lunora%2Fflags?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fflags)                         | OpenFeature-based feature flags for Lunora — ctx.flags, useFlag, and a first-class Cloudflare Flagship provider with any OpenFeature provider pluggable                                                                |
| [`@lunora/hyperdrive`](packages/hyperdrive/README.md)               | [![npm](https://img.shields.io/npm/v/%40lunora%2Fhyperdrive?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fhyperdrive)               | Bring-your-own Postgres/MySQL for Lunora via Cloudflare Hyperdrive: a driver-agnostic, action-only ctx.sql                                                                                                             |
| [`@lunora/mail`](packages/mail/README.md)                           | [![npm](https://img.shields.io/npm/v/%40lunora%2Fmail?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fmail)                           | Email for Lunora: Resend adapter, TSX templates, and queue-backed sends                                                                                                                                                |
| [`@lunora/mcp`](packages/mcp/README.md)                             | [![npm](https://img.shields.io/npm/v/%40lunora%2Fmcp?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fmcp)                             | Model Context Protocol server exposing a Lunora deployment to AI agents                                                                                                                                                |
| [`@lunora/notify`](packages/notify/README.md)                       | [![npm](https://img.shields.io/npm/v/%40lunora%2Fnotify?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fnotify)                       | Multi-channel notifications for Lunora — ctx.notify / ctx.push over @visulima/notification: edge-safe Web Push + FCM, plus chat, in-app inbox and webhook channels, with subscription storage and queue-backed fan-out |
| [`@lunora/payment`](packages/payment/README.md)                     | [![npm](https://img.shields.io/npm/v/%40lunora%2Fpayment?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fpayment)                     | Provider-agnostic payments for Lunora: Stripe-first adapter, webhook sync, and subscription/payment state machine                                                                                                      |
| [`@lunora/queue`](packages/queue/README.md)                         | [![npm](https://img.shields.io/npm/v/%40lunora%2Fqueue?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fqueue)                         | Cloudflare Queues for Lunora: defineQueue producers + consumers, the ctx.queues surface, and the generated queue() worker handler                                                                                      |
| [`@lunora/ratelimit`](packages/ratelimit/README.md)                 | [![npm](https://img.shields.io/npm/v/%40lunora%2Fratelimit?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fratelimit)                 | Rate limiting: token-bucket / fixed-window / sliding-window algorithms, deny list, sharding, pluggable stores, and procedure middleware                                                                                |
| [`@lunora/replica`](packages/replica/README.md)                     | [![npm](https://img.shields.io/npm/v/%40lunora%2Freplica?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Freplica)                     | Local-first replica runtime + local SQLite mirror for Lunora                                                                                                                                                           |
| [`@lunora/scheduler`](packages/scheduler/README.md)                 | [![npm](https://img.shields.io/npm/v/%40lunora%2Fscheduler?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fscheduler)                 | Scheduling for Lunora: runAfter / runAt and Cron Triggers via SchedulerDO                                                                                                                                              |
| [`@lunora/seed`](packages/seed/README.md)                           | [![npm](https://img.shields.io/npm/v/%40lunora%2Fseed?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fseed)                           | Schema-driven, deterministic database seeding for Lunora: realistic fake data from defineSchema                                                                                                                        |
| [`@lunora/storage`](packages/storage/README.md)                     | [![npm](https://img.shields.io/npm/v/%40lunora%2Fstorage?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fstorage)                     | R2-backed storage for Lunora: typed buckets and signed URLs                                                                                                                                                            |
| [`@lunora/workflow`](packages/workflow/README.md)                   | [![npm](https://img.shields.io/npm/v/%40lunora%2Fworkflow?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fworkflow)                   | Durable workflows for Lunora: defineWorkflow over Cloudflare Workflows, generated WorkflowEntrypoint classes, and the ctx.workflows surface                                                                            |

### Observability

| Package                                                     | Version                                                                                                                                                                            | Description                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`@lunora/observability`](packages/observability/README.md) | [![npm](https://img.shields.io/npm/v/%40lunora%2Fobservability?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fobservability) | Host-neutral telemetry storage and read models for Lunora, backing the Studio's Logs, Traces, Metrics and Issues views |

### Platform

| Package                                                                 | Version                                                                                                                                                                                        | Description                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@lunora/platform`](packages/platform/README.md)                       | [![npm](https://img.shields.io/npm/v/%40lunora%2Fplatform?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fplatform)                       | Provider-neutral host contracts for Lunora: shard/socket/directory/scheduler interfaces, binding projections, and the platform capability matrix                                                     |
| [`@lunora/platform-cloudflare`](packages/platform-cloudflare/README.md) | [![npm](https://img.shields.io/npm/v/%40lunora%2Fplatform-cloudflare?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fplatform-cloudflare) | Cloudflare implementation of the Lunora platform contracts: ShardHost, SocketHost, ShardDirectory, ShardKvStore over Durable Objects                                                                 |
| [`@lunora/platform-node`](packages/platform-node/README.md)             | [![npm](https://img.shields.io/npm/v/%40lunora%2Fplatform-node?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fplatform-node)             | Node implementation of the Lunora platform contracts: ShardHost, SocketHost, ShardDirectory, ShardKvStore, SchedulerHost over better-sqlite3 and an in-process socket registry (dev/test target)     |
| [`@lunora/shard-engine`](packages/shard-engine/README.md)               | [![npm](https://img.shields.io/npm/v/%40lunora%2Fshard-engine?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fshard-engine)               | Host-neutral reactive engine for Lunora: per-shard state, OCC, CDC, reactive subscriptions, and the poke protocol. Consumes @lunora/platform host contracts and can be mounted on any platform host. |

### Web3

| Package                                   | Version                                                                                                                                                          | Description                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`@lunora/x402`](packages/x402/README.md) | [![npm](https://img.shields.io/npm/v/%40lunora%2Fx402?style=flat-square&labelColor=292a44&color=663399&label=v)](https://www.npmjs.com/package/%40lunora%2Fx402) | Agentic payments (x402) for Lunora: charge agents per request (charge rail) and let your agents pay x402-gated resources (pay rail) |

<!-- END_TABLE_PLACEHOLDER -->

## Documentation

Full documentation lives at **[lunora.sh/docs](https://lunora.sh/docs)** — guides, core concepts, framework adapters, and per-package reference:

- [Getting started](https://lunora.sh/docs/getting-started) — scaffold an app and run the dev loop in under a minute
- [Queries, mutations & actions](https://lunora.sh/docs/concepts/queries-mutations) — the core authoring model
- [Real-time](https://lunora.sh/docs/concepts/realtime) · [Sharding](https://lunora.sh/docs/concepts/sharding) · [RLS](https://lunora.sh/docs/concepts/rls) — the concepts that make it scale
- [Architecture](https://lunora.sh/docs/architecture) — how the Worker, Durable Objects, and storage fit together
- [Design boundaries](https://lunora.sh/docs/non-goals) — what Lunora deliberately does not do, and the escape hatch for each
- [Deployment](https://lunora.sh/docs/deployment) — ship to your own Cloudflare account
- [Packages](https://lunora.sh/packages) — every `@lunora/*` adapter and add-on

## Status

**Alpha — APIs WILL break.** Packages publish continuously to the **`alpha`** dist-tag on npm (`pnpm add lunorash@alpha`); each package versions independently, so their alpha numbers do not line up. The `latest` tag holds a `0.0.x` placeholder — read `alpha` instead. The surface area, package boundaries, and on-disk layout will all shift before the first non-alpha tag.

Releases are frequent enough to fight pnpm's `minimumReleaseAge`; if you use it, add `"@lunora/*"` and `lunorash` to `minimumReleaseAgeExclude` rather than resolving a set of packages that no longer agree.

You are welcome to read, file issues, and open PRs against the [`alpha`](https://github.com/anolilab/lunora/tree/alpha) branch. Just don't build a production system on it yet.

## Contributing

See [`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md). The default branch is **`alpha`**; PRs target `alpha` unless explicitly cutting a release.

For security reports, see [`SECURITY.md`](./SECURITY.md). For community guidelines, see [`.github/CODE_OF_CONDUCT.md`](./.github/CODE_OF_CONDUCT.md). For brand assets and usage rules, see [`marketing/BRAND.md`](./marketing/BRAND.md).

## License

[FSL-1.1-Apache-2.0](./LICENSE.md) © 2026 anolilab and contributors. Source-available; each release converts to Apache-2.0 two years after it ships.

<!-- badges -->

[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
[scorecard-badge]: https://api.scorecard.dev/projects/github.com/anolilab/lunora/badge?style=for-the-badge
[scorecard]: https://scorecard.dev/viewer/?uri=github.com/anolilab/lunora
[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: ./LICENSE.md
[status-badge]: https://img.shields.io/badge/status-alpha-blueviolet.svg?style=for-the-badge
[status]: #status
[node-badge]: https://img.shields.io/badge/node-%5E22.15%20%7C%7C%20%3E%3D24.11-brightgreen.svg?style=for-the-badge
[node]: ./package.json
[pnpm-badge]: https://img.shields.io/badge/pnpm-11.15.0-f69220.svg?style=for-the-badge
[pnpm]: ./package.json
[ci-badge]: https://img.shields.io/github/actions/workflow/status/anolilab/lunora/test.yml?branch=alpha&style=for-the-badge&label=CI
[ci]: https://github.com/anolilab/lunora/actions/workflows/test.yml
[npm-version-badge]: https://img.shields.io/npm/v/lunorash/alpha?label=lunorash%40alpha&color=cb3837&style=for-the-badge
[npm-version]: https://www.npmjs.com/package/lunorash
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
