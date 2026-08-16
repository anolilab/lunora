# Lander — the Lunora AI app builder

Describe an app, and land it on Cloudflare. Lander is the builder itself; the
apps it generates are ordinary Lunora projects that you own and can eject at any
time.

Design, decisions and the rejected alternatives live in
[`plans/335-ai-app-builder.md`](../../plans/335-ai-app-builder.md). Read that
before changing anything structural here — nearly every shape in this app is a
recorded decision rather than a default.

## Status: W1 (skeleton) only

This is the first workstream of plan 335. What exists:

- The app shell — TanStack Start + Lunora composed into **one** worker via
  `virtual:lunora/worker`, the same composition
  `templates/tanstack-start-react` uses. That is deliberate: the builder
  generates apps from that template, so its own composition being identical is
  what keeps "works here" and "works in a generated app" the same statement.
- The schema (`lunora/schema.ts`) and the project CRUD behind the dashboard.

What does **not** exist yet, and should not be faked:

- **The sandbox** (`@lunora/container/sandbox`, plan W2/E1). A project is a row;
  it has no working tree, so nothing scaffolds, previews, verifies or deploys.
  E1 is deliberately blocked on the Phase 0 latency spike.
- **The build agent** (W3), the skill selection (W4) and the workbench UI (W5).
  The dashboard is the whole of the interface today.

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
pnpm --filter "@lunora/builder" run lint:types   # codegen + tsc (app and _generated)
pnpm --filter "@lunora/builder" run lint:eslint
pnpm --filter "@lunora/builder" run test
```
