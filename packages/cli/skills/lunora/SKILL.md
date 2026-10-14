---
name: lunora
description: Routes general Lunora requests to the right Lunora skill and gives the
    shared mental model (codegen loop, generated `api`/`internal` references,
    review commands, add-on capabilities, the `@lunora/mcp` server). Use when the
    user asks which Lunora skill to use, gives an underspecified task in a project
    with a `lunora/` directory or `lunorash`/`@lunora/*` dependencies, asks to
    review or audit Lunora code, asks about an add-on without its own skill
    (queues, workflows, agents, AI, flags, payments, notifications), or wants to
    expose a deployment to an AI agent over MCP.
---

# Lunora

Lunora is a type-safe, real-time backend on Cloudflare Workers + Durable
Objects. Functions are chainable `query` / `mutation` / `action` builders; state
lives in one `ShardDO` per app by default (SQLite, OCC, hibernated WebSocket
subscriptions). `.shardBy(key)` partitions a table across many DOs and
`.global()` replicates it to D1 (or Postgres/MySQL over Hyperdrive) for
cross-region reads. Codegen produces the types the client and server share.

If a project-level `AGENTS.md` / `CLAUDE.md` exists, read it first; it overrides
these defaults. If a more specific Lunora skill matches, switch to it.

## The feedback loop

```bash
lunora codegen   # regenerate lunora/_generated/ from lunora/schema.ts + function files
lunora verify    # wrangler config + codegen dry-run + tsc --noEmit; writes nothing
```

`lunora codegen` writes `lunora/_generated/` (`api.ts`, `internal.ts`,
`server.ts`, `dataModel.ts`, `shard.ts`, `app.ts`, `openapi.ts`, …; it prints
the exact list) and reports schema advisories and platform diagnostics. It does
not run `tsc`, so use `lunora verify` as the check that the code you wrote is
done. Its `tsc --noEmit` step runs only when the project has a `tsconfig.json`
(otherwise it warns and skips) and is turned off by `--no-typecheck`. `lunora dev` re-runs codegen on save, and `lunora deploy` runs it too.
Scaffolded projects gitignore `lunora/_generated/`; never hand-edit it.

## Route to the right skill

- New project, or adding Lunora to an existing app: `lunora-quickstart`
- Writing or reviewing schema + functions (the core authoring rules):
  `lunora-functions`
- Wiring live data into a client (hooks, optimistic updates): `lunora-realtime`
- Authentication (email/password, OAuth, magic link, OTP): `lunora-setup-auth`
- Transactional email: `lunora-setup-mail`
- R2 file storage (signed upload/download): `lunora-setup-storage`
- Deferred work (`ctx.scheduler`) and cron jobs: `lunora-setup-scheduler`
- Querying an existing Postgres/MySQL database from an action (`ctx.sql`,
  non-reactive): `lunora-setup-hyperdrive`
- Postgres/MySQL as a reactive `.global()` backend, or migrating a D1
  `.global()` dataset onto it: `lunora-setup-hyperdrive-global`
- Building a reusable capability (registry item or `@lunora/*` package):
  `lunora-create-package`
- Schema/data migrations: `lunora-migration-helper`
- Deploying (wrangler, bindings, secrets, the drift gate): `lunora-deploy`
- Slow queries, scans, write conflicts: `lunora-performance-audit`

### Reviewing existing `lunora/` code

There is no review skill because two commands do the mechanical part. Run them
before reading code by hand:

```bash
lunora verify    # does it build and typecheck
lunora advisor   # static + runtime lint set, scored per procedure
```

`lunora advisor` covers RLS coverage, ownership and identity checks, fail-open
guards, input validators, unindexed reads, non-deterministic calls in queries,
SQL interpolation and leaked secrets. It prints each finding's lint id and
category, so read its output rather than guessing rule names. `--entry
<file>#<export>` inspects one procedure; `--min-score` / `--baseline` gate CI.
Once it is clean, a by-hand pass against `lunora-functions` is worth the tokens.

## Core mental model

- Functions live in `lunora/**/*.ts` and import their builders from the
  generated server module: `query` (reactive read), `mutation` (transactional
  write), `action` (side effects, `fetch`, no direct db). `internalQuery` /
  `internalMutation` / `internalAction` are not callable from clients.
- Schema lives in `lunora/schema.ts` (`defineSchema` + `defineTable`, validators
  from `v.*`), imported from `lunorash/server` or `@lunora/server`.
- Function references mirror the folder tree: `lunora/billing/invoices.ts`
  exporting `create` is `api.billing.invoices.create`. Public references come
  from `_generated/api`, internal ones from `_generated/internal` (kept separate
  so client bundles never carry internal names). A reference is a plain
  `{ __lunoraRef: "billing_invoices:create" }` object; there is no `anyApi`
  proxy.
- Reads go through indexes: declare `.index("by_x", ["x"])` and query with
  `ctx.db.query("t").withIndex("by_x", (q) => q.eq("x", value))`, not
  `.filter(...)`.
- Clients subscribe over WebSocket; `useQuery` re-renders when a mutation
  changes the queried rows. Subscriptions run under the socket's verified
  identity, so `rls()` and `ctx.auth` apply to live updates too.

## Capabilities without a dedicated skill

Most add-ons install as a registry item: `lunora add <feature>` (or
`lunora registry add <item>`) scaffolds the `lunora/` glue, wrangler bindings
and `.dev.vars` entries, then prints post-install steps. Browse with
`lunora registry list`, preview with `lunora registry view <item>`. Read the
installed item's README and the package's `docs/` for the API.

| Goal                                          | Install / package                                          |
| --------------------------------------------- | ---------------------------------------------------------- |
| Background jobs on Cloudflare Queues          | `lunora add queue` → `@lunora/queue` (`ctx.queues`)        |
| Durable multi-step workflows                  | `lunora add workflow` → `@lunora/workflow` (`ctx.runStep`) |
| Durable AI agents (tool loops, HITL, memory)  | `@lunora/agent` (`defineAgent`)                            |
| Workers AI / RAG                              | `lunora add ai` → `@lunora/ai` (`ctx.ai`, `defineRag`)     |
| Feature flags (OpenFeature)                   | `lunora add flags` → `@lunora/flags` (`ctx.flags`)         |
| Payments (Stripe / Polar)                     | `lunora add payment` → `@lunora/payment`                   |
| Agent payments (x402)                         | `@lunora/x402`                                             |
| Push / in-app / webhook notifications         | `@lunora/notify` (`ctx.notify`, `ctx.push`)                |
| Rate limiting                                 | `lunora add ratelimit` → `@lunora/ratelimit`               |
| Headless browser (action-only)                | `lunora add browser` → `@lunora/browser` (`ctx.browser`)   |
| Cloudflare Containers                         | `@lunora/container` (`defineContainer`, `ctx.containers`)  |
| Presence / who's-here                         | `lunora add presence`                                      |
| Cloudflare Access (Zero Trust) identity       | `lunora add cloudflare-access`                             |
| Backup / restore                              | `lunora add backup`                                        |
| Testing (in-memory harness, agent doubles)    | `@lunora/testing` (`lunoraTest`)                           |
| Deterministic seed data                       | `@lunora/seed` + `lunora seed`                             |
| Local-first replica / offline mirror          | `@lunora/replica`                                          |
| Exposing the deployment to AI agents over MCP | `@lunora/mcp` (below)                                      |

Inside the Lunora monorepo, `vis generate lunora-<kind>` scaffolds code:
`query`, `mutation`, `action`, `http-route`, `table`, `cron`, `container`,
`workflow`, `queue`, `step`, `agent`, `package`, plus the no-name singletons
`flags`, `auth-do` and `collections` (`vis generate --list` for the set). Pass
names as `--name=value`: vis parses `--name foo` as `--name=true` plus a stray
positional.

## Exposing a deployment over MCP

Two entry points:

- `lunora mcp install` wires an editor (Claude Code, Cursor, …) to the hosted
  docs server plus this project's dev server; `lunora mcp serve` is the stdio
  server those entries spawn (`--allow-writes`, `--token` opt into more).
- The `lunora-mcp` binary from `@lunora/mcp` fronts a deployed Worker. It needs
  `LUNORA_URL` and `LUNORA_ADMIN_TOKEN`. Every tool reads admin-gated routes, so
  the token cannot be scoped down; safety comes from the gates below.

Always advertised: `lunora_list_functions`, `lunora_list_tables` (`.global()`
tables with row counts), `lunora_get_function_schema`, `lunora_run_query`
(read-only), and `lunora_explain_error`, which explains an error `code` or
message from the catalog compiled into `@lunora/errors` and needs no
deployment. Use it before guessing what a Lunora error means.

Everything else sits behind an env gate that both hides the tool and refuses it
at dispatch. All default to off; enable one only when the answer to "may a model
see this?" is yes.

- `LUNORA_MCP_ALLOW_WRITES` → `lunora_run_mutation`, `lunora_run_action`.
- `LUNORA_MCP_ALLOW_OBSERVABILITY` → the five `lunora_get_*` tools (logs,
  issues, advisories, query insights, migration status). Read-only, but they
  return production log lines and error messages, which then reach the model
  provider.
- `LUNORA_MCP_ALLOW_DATA_READS` → `lunora_find_related`. It returns raw rows
  read through the admin writer, with RLS and column masks bypassed. It is kept
  separate from observability so enabling logs never also hands over rows.
- `LUNORA_MCP_ALLOW_AGENTS` (with `LUNORA_MCP_AGENTS="name:description;…"`) →
  the `agent_<name>` tools and `lunora_agent_status`.

Writes are a two-step handshake. The first `lunora_run_mutation` /
`lunora_run_action` call does not execute; it returns `status:
"action_required"` with `proposedAction`, an `actionDigest`, and an `expiresAt`
ten minutes out. The client shows that to a human, then repeats the call with
identical `functionPath`, `args` and `shardKey` plus `confirmed: true` and the
digest. Any edit needs a fresh proposal, and an expired digest is refused. The
digest proves the write that runs is the one proposed; it does not prove a human
saw it, so enabling writes means trusting the client to ask.
