# Lander — the Lunora AI app builder

Describe an app, and land it on Cloudflare. Lander is the builder itself; the
apps it generates are ordinary Lunora projects that you own and can eject at any
time.

Design, decisions and the rejected alternatives live in
[`plans/335-ai-app-builder.md`](../../plans/335-ai-app-builder.md). Read that
before changing anything structural here — nearly every shape in this app is a
recorded decision rather than a default.

## Status: first full version

The whole loop exists end to end — dashboard → workbench → agent → files →
commands. What is **simulated rather than real** is called out below and, more
importantly, in the product itself.

Shipped:

- **The app shell.** TanStack Start + Lunora composed into one worker via
  `virtual:lunora/worker`, the same composition `templates/tanstack-start-react`
  uses. The builder generates apps from that template, so its own composition
  being identical keeps "works here" and "works in a generated app" the same
  statement.
- **The workbench** (`/p/$projectId`) — chat, file tree, editor, terminal. Every
  pane is a live subscription; an agent write lands in the `files`/`messages`
  tables and each open pane re-renders. There is no SSE endpoint and no polling.
- **The build agent** (`lunora/agents.ts`) — `defineAgent` compiled onto a
  Cloudflare Workflow, with `ls` / `view` / `write` / `edit` / `exec` / `verify`.
  Every tool dispatches a Lunora function, so the rules it enforces (path safety,
  the command allowlist, the exactly-one-match edit) live where they can be
  tested without a model.
- **The skill corpus**, compiled from `packages/cli/skills/*/SKILL.md` by
  `scripts/build-skills.mjs`. One source of truth; no second prompt corpus.

**Simulated, and labelled as such.** With no container binding the sandbox falls
back to `simulatedDriver`, which answers the handful of commands the agent
issues and refuses everything else. The terminal stamps every line with the
driver that answered — `simulated` or `container` — because a builder that
quietly reports simulated success is worse than one with no terminal at all.
Both drivers enforce the same allowlist and both _reject_ rather than throw, so
the simulation cannot teach the agent habits the real driver refuses.

Still missing, deliberately:

- **A real sandbox** (`@lunora/container/sandbox`, plan E1) — blocked on the
  Phase 0 latency spike. The container driver is wired and typed; it runs
  commands but does not yet sync the working tree in or read it back.
- **Preview and deploy** (W6), **accounts and token quotas** (W7), **evals**
  (W8), **share/fork/export** (W9). The rate limits in `lunora/limits.ts` are
  abuse protection, not D17's token budget.

## Running it

```bash
pnpm --filter "@lunora/builder" run dev
```

`lunora dev` provisions a local D1 for the `.global()` tables. For a real
deploy, create the database and paste its id into `wrangler.jsonc`:

```bash
wrangler d1 create lunora-builder
```

## Storage tiers

The one thing worth knowing before touching `lunora/schema.ts`:

| Tier                    | Tables                                    | Why                                                                                                                         |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `.global()` (D1)        | `projects`, `shares`, `users`             | Each is read on a path with **no project in hand** — "list my projects", "resolve this share token", "who is this session". |
| `.shardBy("projectId")` | `chats`, `messages`, `snapshots`, `usage` | Only ever read with a project already resolved, and the high-write tables. A busy project must not contend with another.    |

`__tests__/schema.test.ts` pins both lists. Moving a table between tiers is a
migration once there is data, and neither mistake shows up in a typecheck — a
sharded `projects` turns the dashboard into a cross-shard fan-out, and a
non-sharded `messages` puts every project's build traffic on the root DO.

## Checks

```bash
pnpm --filter "@lunora/builder" run lint:types    # codegen + tsc (app and _generated)
pnpm --filter "@lunora/builder" run lint:eslint
pnpm --filter "@lunora/builder" run test
pnpm --filter "@lunora/builder" run build:skills  # after packages/cli/skills changes
```
