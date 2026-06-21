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
replicates a table to D1 for low-latency cross-region reads. A Vite plugin
drives codegen and end-to-end type sync.

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
- Wiring a prebuilt capability (mail, file storage, scheduled jobs, rate
  limiting, vectors, AI, containers, payments, MCP): install it with
  `lunora registry add <item>` (see `lunora registry list`). Capabilities with a
  dedicated skill: `lunora-setup-mail` (mail), `lunora-setup-storage` (R2 file
  storage), `lunora-setup-scheduler` (deferred `ctx.scheduler` + cron jobs). For
  the rest, read the item's README after installing.
- Building a reusable capability — a registry item or an `@lunora/*` package:
  `lunora-create-package`
- Planning or running a schema/data migration: `lunora-migration-helper`
- Deploying to Cloudflare (wrangler, bindings, secrets, the drift gate):
  `lunora-deploy`
- Investigating performance, scan, or write-conflict issues:
  `lunora-performance-audit`

If one of those clearly matches the user's goal, switch to it instead of staying
in this skill.

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
  Solid, Svelte) re-render the moment a mutation changes the queried rows.

## When Not to Use

- The user has already named a more specific Lunora workflow.
- Another Lunora skill obviously fits the request better.
