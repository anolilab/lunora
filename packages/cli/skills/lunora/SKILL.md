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

**Reviewing or auditing existing `lunora/` code** has no skill of its own,
because two commands do the work mechanically — run them before reading
anything:

```bash
lunora verify    # wrangler config + codegen dry-run + tsc --noEmit
lunora advisor   # the static + runtime lint set, scored per procedure
```

`lunora advisor` is the security/quality review: RLS coverage, ownership and
identity checks, fail-open guards, input validators, unindexed reads,
non-deterministic calls in queries, SQL interpolation, and leaked secrets. It
prints each finding's own lint id and category, so read its output rather than
grepping for rule names. Use `--entry <file>#<export>` to inspect one procedure
and `--min-score` / `--baseline` to gate CI. Only after it is clean is a by-hand
pass over `lunora-functions` worth the tokens.

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

## Exposing a Deployment Over MCP

`@lunora/mcp` puts a **running deployment** behind an MCP server (`lunora-mcp`),
so an agent can introspect and call it. It needs `LUNORA_URL` and
`LUNORA_ADMIN_TOKEN` — the admin bearer, which cannot be scoped down, because
every tool reads admin-gated routes. The safety story is therefore the gates
below, never the credential.

Always advertised, no gate:

| Tool                         | What it does                                                           |
| ---------------------------- | ---------------------------------------------------------------------- |
| `lunora_list_functions`      | The deployment's public functions and their kinds.                     |
| `lunora_list_tables`         | `.global()` tables with row counts.                                    |
| `lunora_get_function_schema` | One function's argument descriptors, so a caller can build valid args. |
| `lunora_run_query`           | Runs a query. Read-only.                                               |
| `lunora_explain_error`       | Explains an error `code` or raw `message` from the static catalog.     |

`lunora_explain_error` touches no deployment and needs no token — the catalog is
compiled into `@lunora/errors`. Reach for it before guessing at what a Lunora
error means.

**Three env gates hold back everything else.** Each one both omits the tool from
the advertised list _and_ refuses it at dispatch, so the guarantee does not
depend on the client behaving:

- `LUNORA_MCP_ALLOW_WRITES` → `lunora_run_mutation`, `lunora_run_action`.
- `LUNORA_MCP_ALLOW_OBSERVABILITY` → the five `lunora_get_*` tools (logs,
  issues, advisories, query insights, migration status). Read-only, but they
  return production log lines and error messages — user data that lands at the
  model provider.
- `LUNORA_MCP_ALLOW_DATA_READS` → `lunora_find_related`. **It returns raw table
  rows read through the deployment's admin writer, with RLS policies and column
  masks bypassed**, plus everything reachable within `depth` hops. It is
  deliberately not folded into the observability gate: enabling log reading for
  debugging must not silently also hand over every row.

All three default to **off**. Set one only when the answer to "may a model see
this?" is yes.

### Writes are a two-step handshake

Past `LUNORA_MCP_ALLOW_WRITES`, each individual write still needs its own
confirmation. The first `lunora_run_mutation` / `lunora_run_action` call does
**not** execute — it returns `status: "action_required"` carrying
`proposedAction`, an `actionDigest`, and the `expiresAt` it is valid until (ten
minutes). The client shows that to a human, then calls the same tool again with
the identical `functionPath`, `args` and `shardKey`, plus `confirmed: true` and
that digest.

Editing anything produces a different digest and needs a fresh proposal; an
expired digest is refused rather than quietly re-proposed. Be precise about what
this buys: the digest binds the **call**, proving the write that runs is exactly
the one proposed on this deployment inside the window. It does **not** prove a
human ever saw it — an MCP server has no channel to a person, and a client that
asks nobody can echo the digest straight back. Enabling writes is the operator
asserting that the client on the other end does the asking.

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
