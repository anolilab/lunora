# Lunora examples

Runnable apps, each one built around a different part of the framework. Every
one deploys to your own Cloudflare account in a click — the button clones the
repo, provisions the bindings its `wrangler.jsonc` declares, prompts for any
secret listed in `.dev.vars.example`, and deploys.

| Example                                    | What it is                                           | Shows off                                                                                  | Deploy                                                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [kanban-board](./kanban-board)             | Drag-and-drop board, live for everyone looking at it | Fractional index ordering, server-resolved drops, multi-query optimistic updates           | [![Deploy](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anolilab/lunora/tree/alpha/examples/kanban-board)   |
| [feedback-board](./feedback-board)         | Public feature-request board with AI summaries       | Unique index as a constraint, denormalised counters, `ctx.ai` from an action               | [![Deploy](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anolilab/lunora/tree/alpha/examples/feedback-board) |
| [team-chat](./team-chat)                   | Channels, presence, search, file uploads             | A shard per channel, all three data tiers, `authorizeShard`, signed R2 uploads             | [![Deploy](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anolilab/lunora/tree/alpha/examples/team-chat)      |
| [chess](./chess)                           | Multiplayer chess with lobbies, spectators and Elo   | Server-authoritative rules, serialized mutations as a game rule, in-transaction settlement | [![Deploy](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anolilab/lunora/tree/alpha/examples/chess)          |
| [tanstack-start](./tanstack-start)         | SSR that hands over to a live socket                 | Route loaders sharing a cache key with `useQuery`, one worker for SSR + RPC                | [![Deploy](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anolilab/lunora/tree/alpha/examples/tanstack-start) |
| [todo-app](./todo-app)                     | The smallest CRUD round-trip                         | `defineSchema`, one query + one mutation, optimistic updates                               | —                                                                                                                                                                           |
| [blog](./blog)                             | Posts, drafts, semantic search                       | `.global()` tables, `.vectorize()`, R2 images, a nightly cron                              | —                                                                                                                                                                           |
| [realtime-cursors](./realtime-cursors)     | Shared cursors, one shard per room                   | `.shardBy()` and per-room WebSocket fan-out                                                | —                                                                                                                                                                           |
| [auth-playground](./auth-playground)       | Sign-in, organizations, admin, 2FA                   | `@lunora/auth` with the better-auth plugin surface                                         | —                                                                                                                                                                           |
| [payment-demo](./payment-demo)             | Checkout and subscription state                      | `@lunora/payment`, webhook sync, entitlements                                              | —                                                                                                                                                                           |
| [notify-demo](./notify-demo)               | Web Push notifications                               | `@lunora/notify`, subscription stores, queue fan-out                                       | —                                                                                                                                                                           |
| [offline-rejections](./offline-rejections) | What an offline queue does when the server says no   | Durable offline outbox, rejection replay                                                   | —                                                                                                                                                                           |
| [expo](./expo)                             | React Native client                                  | `@lunora/react-native`, the Expo auth bridge                                               | —                                                                                                                                                                           |

## Which examples are safe to deploy

`team-chat` and `chess` require a sign-in. The other three deliberately have no
auth — they exist to demonstrate one mechanism each — so a deployed instance is
open to anyone with the URL. Each says so above its own deploy button.

## Composing the worker: two shapes

`team-chat` and `chess` build their worker with the generated `defineApp()`
builder; `kanban-board`, `feedback-board` and the older `blog` /
`auth-playground` call `createWorker` + `createShardDO` directly.

**Prefer `defineApp()`.** It wires both halves of a capability together — the
`ctx.*` surface inside the shard and the matching admin/studio surface on the
worker — so the two cannot disagree. The hand-rolled form is worth reading once
to see what the builder does, and it is the right choice when you need a
capability the builder does not model, but it is easy to get subtly wrong:
omitting `.global()`'s D1 binding, for instance, compiles cleanly and then
throws "no global backend configured" on the first read of a `.global()` table.
The examples with no bindings at all (`kanban-board`, `feedback-board`) stay on
the direct form precisely because there is nothing to wire.

## Running any of them locally

```bash
pnpm install
pnpm --filter @lunora-example/<name> dev
```

Then open <http://localhost:5173>. Examples that need a D1 database, an R2
bucket, or a secret say so in their own README — everything else runs offline in
Miniflare.

## A note on the deploy buttons

Cloudflare's deploy flow builds the example from its subdirectory in this
monorepo. If a build fails on dependency resolution, deploy from a checkout
instead — it is two commands and does the same thing:

```bash
pnpm install
pnpm --filter @lunora-example/<name> run deploy
```
