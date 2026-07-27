---
name: lunora
description: Routes general Lunora requests to the right project skill. Use when the user
    asks which Lunora skill to use, or gives an underspecified task for a Lunora
    app (a type-safe, real-time backend on Cloudflare Workers + Durable Objects
    with a Vite-first DX).
---

# Lunora

Use this as the routing skill for Lunora work in this repo.

Lunora exposes a Convex-style functional API (`defineSchema`, `query`,
`mutation`, `action`) on top of Cloudflare Workers and Durable Objects. State
lives in a per-app `ShardDO` (SQLite, OCC, hibernated WebSocket subscriptions)
by default; `.shardBy(key)` partitions it across many DOs and `.global()`
replicates a table to D1 — or to Postgres/MySQL over Hyperdrive — for
low-latency cross-region reads. A Vite plugin drives codegen and end-to-end
type sync.

If a more specific Lunora skill clearly matches the request, use that instead.

## Start Here

Before writing or changing any `lunora/` code, make sure the generated types are
current — they are the contract the client and server share.

```bash
lunora codegen
```

This regenerates `lunora/_generated/` (`api.ts`, `server.ts`, `dataModel.ts`,
`shard.ts`, `openapi.ts`, …) from `lunora/schema.ts` and your function files. The
output typechecks your schema and functions, so it doubles as the agent's main
feedback loop after each edit. Commit `lunora/_generated/` — it is part of the
source tree, not a build artifact to gitignore.

If a project-level `AGENTS.md` / `CLAUDE.md` exists, read it first — it overrides
these defaults.

## Route to the Right Skill

After codegen is green, use the most specific Lunora skill for the task:

- New project, or adding Lunora to an existing app: `lunora-quickstart`
- Writing or reviewing schema + functions (the core authoring rules):
  `lunora-functions`
- Wiring live data into a client (hooks, optimistic updates): `lunora-realtime`
- Authentication setup (email/password, OAuth, magic link, OTP):
  `lunora-setup-auth`
- Transactional email: `lunora-setup-mail`
- R2 file storage (signed upload/download): `lunora-setup-storage`
- Deferred work (`ctx.scheduler`) and cron jobs: `lunora-setup-scheduler`
- Querying an **existing** Postgres/MySQL database from an action (`ctx.sql`,
  non-reactive): `lunora-setup-hyperdrive`
- Using Postgres/MySQL as a **reactive `.global()` backend**, or migrating a D1
  `.global()` dataset onto it: `lunora-setup-hyperdrive-global`
- Building a reusable capability — a registry item or an `@lunora/*` package:
  `lunora-create-package`
- Planning or running a schema/data migration: `lunora-migration-helper`
- Deploying to Cloudflare (wrangler, bindings, secrets, the drift gate):
  `lunora-deploy`
- Investigating performance, scan, or write-conflict issues:
  `lunora-performance-audit`

If one of those clearly matches the user's goal, switch to it instead of staying
in this skill.

## Capabilities Without a Dedicated Skill

Most other capabilities install as a **registry item** — `lunora registry add
<item>` scaffolds the `lunora/` glue, wrangler bindings, and env vars, then
prints post-install steps. Browse with `lunora registry list`; preview with
`lunora registry view <item>`. Read the installed item's README, and the
package's `docs/` for the API.

| Goal                                          | Install / package                                            |
| --------------------------------------------- | ------------------------------------------------------------ |
| Background jobs on Cloudflare Queues          | `registry add queue` → `@lunora/queue` (`ctx.queues`)        |
| Durable multi-step workflows                  | `registry add workflow` → `@lunora/workflow` (`ctx.runStep`) |
| Durable AI agents (tool loops, HITL, memory)  | `@lunora/agent` (`defineAgent`)                              |
| Workers AI / RAG                              | `registry add ai` → `@lunora/ai` (`ctx.ai`, `defineRag`)     |
| Feature flags (OpenFeature)                   | `registry add flags` → `@lunora/flags` (`ctx.flags`)         |
| Payments (Stripe / Polar)                     | `registry add payment` → `@lunora/payment`                   |
| Rate limiting                                 | `registry add ratelimit` → `@lunora/ratelimit`               |
| Headless browser (action-only)                | `registry add browser` → `@lunora/browser` (`ctx.browser`)   |
| Cloudflare Containers                         | `@lunora/container` (`defineContainer`, `ctx.containers`)    |
| Presence / who's-here                         | `registry add presence`                                      |
| Cloudflare Access (Zero Trust) identity       | `registry add cloudflare-access`                             |
| Backup / restore                              | `registry add backup`                                        |
| Testing (in-memory harness, agent doubles)    | `@lunora/testing` (`lunoraTest`)                             |
| Deterministic seed data                       | `@lunora/seed` + `lunora seed`                               |
| Local-first replica / offline mirror          | `@lunora/replica`                                            |
| Exposing the deployment to AI agents over MCP | `@lunora/mcp`                                                |

Scaffolding inside this repo uses `vis generate lunora-<kind>` — `query`,
`mutation`, `action`, `http-route`, `table`, `cron`, `container`, `workflow`,
`queue`, `step`, `agent`, `flags`, `collections`, `package` (`vis generate
--list` for the full set). Most take a name: **always** pass it as
`--name=value`, since vis parses a space-separated `--name foo` as `--name=true`
plus a stray positional. `lunora-flags` and `lunora-collections` are singletons
and take no name.

## Core Mental Model

- **Functions** live in `lunora/*.ts` and are one of `query` (reactive read),
  `mutation` (transactional write), or `action` (side effects / `fetch` / no
  direct db). `internalQuery` / `internalMutation` / `internalAction` are the
  non-public variants.
- **Schema** lives in `lunora/schema.ts` via `defineSchema` + `defineTable`,
  with validators from `v.*` (re-exported by `@lunora/server`).
- **Reads go through indexes.** Prefer `ctx.db.query("t").withIndex(...)` over
  `.filter(...)`; declare the index with `.index("by_x", ["x"])`.
- **Clients** subscribe over WebSocket. `useQuery`/`useMutation` (React, Vue,
  Solid, Svelte, React Native; signals in Angular) re-render the moment a
  mutation changes the queried rows. Subscriptions run under the socket's
  verified identity, so `rls()` / `ctx.auth` apply to live updates too.

## When Not to Use

- The user has already named a more specific Lunora workflow.
- Another Lunora skill obviously fits the request better.
