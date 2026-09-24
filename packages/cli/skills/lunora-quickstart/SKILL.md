---
name: lunora-quickstart
description: Creates or adds Lunora to an app. Use for new Lunora projects, `lunora init`,
    framework/provider wiring, the first `lunora dev` run, env vars, or writing
    the first schema + query/mutation round-trip.
---

# Lunora Quickstart

Set up a working Lunora project as fast as possible.

## When to Use

- Starting a brand new project with Lunora.
- Adding Lunora to an existing Vite, Next.js, Astro, Nuxt, SvelteKit, or
  TanStack Start app.
- Scaffolding a Lunora app for prototyping.

## When Not to Use

- The project already has Lunora installed and `lunora/` exists — just build,
  and run `lunora codegen` after schema/function edits.
- You only need to add auth to an existing Lunora app — use the
  `lunora-setup-auth` skill.

## Workflow

1. Determine the starting point: new project or existing app.
2. New project: scaffold with `lunora init` and pick a template.
3. Existing app: run `lunora init --here` to patch the Vite config and wire
   Lunora into the current project.
4. Run `lunora codegen` to generate `lunora/_generated/` and typecheck the
   schema + functions. This is the agent's feedback loop.
5. Start the dev loop. As an agent, run `lunora dev --background` — it starts
   the server as a managed detached process, blocks until it accepts requests,
   prints the URL + PID, and returns (under a detected AI agent, plain
   `lunora dev` does this automatically, with JSON logs). Never leave a bare
   `lunora dev` running in your own shell — it is long-running and does not
   exit.
6. Verify a query/mutation round-trip works end to end.

## Path 1: New Project (Recommended)

`lunora init` fetches a whole-project template (frontend + worker entry + Vite
plugin + `lunora/` already wired together).

```bash
lunora init my-app --vite react
cd my-app
pnpm install
```

### Pick a stack: `--vite` (SPA) or `-t` (bespoke template)

There are **two scaffold paths**, and they take different flags:

**`--vite <framework>` — the create-vite overlay.** Fetches the official
create-vite base and applies the Lunora layer on top. Use it for a plain SPA:

| `--vite` value | Stack                                           |
| -------------- | ----------------------------------------------- |
| `react`        | React SPA (**the default**)                     |
| `vue`          | Vue SPA                                         |
| `solid`        | Solid SPA                                       |
| `svelte`       | Svelte SPA                                      |
| `vanilla`      | No framework (overlay-only — not in the picker) |

**`-t` / `--template <type>` — a bespoke Lunora template.** Whole-project
templates fetched remotely (via `giget`) from
`gh:anolilab/lunora/templates/<type>`:

| `-t` value             | Stack                                                      |
| ---------------------- | ---------------------------------------------------------- |
| `next`                 | Next.js (App Router, OpenNext on Cloudflare)               |
| `tanstack-start-react` | TanStack Start (React) — SSR with live-loader routes       |
| `tanstack-start-solid` | TanStack Start (Solid)                                     |
| `solid-v2`             | Solid 2.0 SPA (`@solidjs/web`, `vite-plugin-solid` 3)      |
| `react-router`         | React Router v7 (framework mode), SSR in the Lunora worker |
| `astro`                | Astro + a standalone Lunora worker                         |
| `analog`               | AnalogJS (Angular) — single worker, Lunora in Nitro        |
| `nuxt`                 | Nuxt (Vue) — single worker, Lunora in Nitro                |
| `sveltekit`            | SvelteKit + a standalone Lunora worker                     |
| `expo`                 | React Native (Expo) — iOS/Android/web + a Lunora worker    |
| `standalone`           | Worker-only Lunora backend, no frontend                    |

> There is **no `--template vite`.** SPAs go through `--vite <framework>`; `-t`
> is only for the bespoke templates above. The one exception is `solid-v2`:
> create-vite's Solid base is still 1.x, and Solid 2.0 needs its own renderer
> package, `jsxImportSource`, and Vite plugin major — so it ships as a template
> rather than an overlay. `--vite solid` stays on Solid 1.x.

With neither flag, an interactive run shows the framework picker (defaulting to
the React overlay) and a **non-interactive run errors out** — so as an agent,
always pass `--vite` or `-t` explicitly. If the user stated no preference,
use `--vite react`.

### Useful `init` flags

```bash
lunora init my-app --vite react --ci github     # + a GitHub Actions deploy pipeline (or --ci gitlab)
lunora init my-app -t next --add auth,email     # scaffold capabilities non-interactively
lunora init my-app --vite react --yes           # skip the interactive auth/email offer
lunora init my-app --vite react --dry-run       # walk every step, write nothing
```

`--add` accepts a comma-separated list of `ai | auth | backup | browser |
cloudflare-access | crons | email | flags | hyperdrive | payment | presence |
queue | storage | workflow`. `--ref <branch|tag|commit>` pins the template
source (e.g. `--ref alpha`); `--from <dir>` copies from a local templates root
offline (expects `<type>/` subdirs).

### Generate types and push the first run

Run this yourself — it is one-shot and exits cleanly:

```bash
lunora codegen
```

It writes `lunora/_generated/` and typechecks your schema + functions. Read its
output to find out whether the code you just wrote is valid.

### Start the dev loop

```bash
lunora dev
```

`lunora dev` runs the Vite dev server with the Cloudflare Worker on the same
origin, plus codegen-on-save and the Lunora Studio. It is long-running and does
not exit, so:

- **Local development (user at the keyboard):** ask the user to run `lunora dev`
  in a terminal.
- **Agents:** run `lunora dev --background`. It detaches the server, waits until
  it answers HTTP, prints `Dev server running at <url> (pid <n>)`, and exits —
  no orphaned shell, no PID bookkeeping. When Lunora detects an AI agent
  (Claude Code, Cursor, Codex, …), plain `lunora dev` flips into this mode
  automatically with JSON logs; `LUNORA_AGENT_MODE=0` opts out.

Manage the running server afterwards:

```bash
lunora dev status --json   # machine-readable: url, pid, uptime, logFile
lunora dev logs --lines 50 # tail the captured output (.lunora/dev.log)
lunora dev stop            # idempotent — succeeds even if nothing runs
```

A second `lunora dev` never double-starts: it reports the existing instance
(`.lunora/dev.json` is the lockfile). Probe readiness or liveness at
`GET /_lunora/status` (`{"ok":true}`).

Vite serves on `http://localhost:5173` by default; the Worker is served on the
same origin via `@cloudflare/vite-plugin`.

## Path 2: Add Lunora to an Existing App

Use this when the user already has a Vite-based frontend and wants Lunora as the
backend.

```bash
lunora init --here
```

This finds the existing `vite.config.*` (or creates a minimal one), patches in
the Lunora Vite plugin, and scaffolds a starter `lunora/`. Then run
`lunora codegen` and `lunora dev` as above.

### Wire up the client provider

Create the `LunoraClient` once at module scope (never inside a component) and
wrap the app with the framework provider. React example:

```tsx
// src/client/main.tsx
import { LunoraClient } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

// @cloudflare/vite-plugin serves the Worker on the same origin as Vite.
const url = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin;
const client = new LunoraClient({ url });

createRoot(document.querySelector("#root")!).render(
    <StrictMode>
        <LunoraProvider client={client}>
            <App />
        </LunoraProvider>
    </StrictMode>,
);
```

Every client adapter has a matching provider: `@lunora/vue`, `@lunora/solid`,
`@lunora/svelte`, `@lunora/angular` (`provideLunora` / `injectLunoraClient`),
and `@lunora/react-native` (`createLunoraClient`, re-exporting `@lunora/react`).
For meta-frameworks, `@lunora/astro` and `@lunora/nuxt` mount Lunora on the
server side. `VITE_LUNORA_URL` is optional — it defaults to `location.origin`,
which is correct for the single-origin dev setup.

## Writing Your First Function

Create a schema and a query/mutation to verify the full loop.

`lunora/schema.ts`:

```ts
import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
    todos: defineTable({
        text: v.string(),
        done: v.boolean(),
        createdAt: v.number(),
    }).index("by_creation", ["createdAt"]),
});
```

`lunora/todos.ts`:

```ts
import type { Id } from "#lunora/_generated/server.js";
import { mutation, query, v } from "#lunora/_generated/server.js";

export const list = query.query(async ({ ctx }) => ctx.db.query("todos").withIndex("by_creation").collect());

export const add = mutation
    .input({ text: v.string() })
    .mutation(async ({ ctx, args: { text } }): Promise<Id<"todos">> => ctx.db.insert("todos", { text, done: false, createdAt: Date.now() }));
```

Run `lunora codegen`, then use it in a component. The `api` object and `Doc` /
`Id` types come from `lunora/_generated/`:

```tsx
import { useMutation, useQuery } from "@lunora/react";

import { api } from "../../lunora/_generated/api";
import type { Doc } from "../../lunora/_generated/dataModel";

function Todos() {
    const todos = useQuery(api.todos.list, {}) as Doc<"todos">[] | undefined;
    const { mutate: add, pending } = useMutation(api.todos.add);

    return (
        <div>
            <button disabled={pending} onClick={() => add({ text: "New todo" })}>
                Add
            </button>
            {todos?.map((t) => (
                <div key={t._id}>{t.text}</div>
            ))}
        </div>
    );
}
```

`useQuery` opens a live subscription: the list re-renders the instant any
mutation changes the queried rows.

## Development vs Production

Use `lunora dev` during development. When ready to ship:

```bash
lunora deploy
```

`lunora deploy` runs codegen, the schema-drift gate, and `wrangler deploy`. Do
not use it during day-to-day development.

Before deploying, run the preflight:

```bash
lunora doctor
```

It checks `wrangler.jsonc` (the `SHARD` durable-object binding), D1 placeholder
ids, `.dev.vars` secrets, and container exports.

## Next Steps

- Add authentication: use the `lunora-setup-auth` skill.
- Add a prebuilt capability (mail, presence, storage, rate limit, crons):
  `lunora registry add <item>` (see `lunora registry list`). For capabilities
  with a dedicated skill, use it: `lunora-setup-mail`, `lunora-setup-storage`,
  `lunora-setup-scheduler`. See the `lunora` router's capability entry for the
  full routing.
- Build your own reusable capability: use the `lunora-create-package` skill.
- Plan a schema change: use the `lunora-migration-helper` skill.
- Scaffold more functions: `vis generate lunora-query --name=listMessages`,
  `lunora-mutation`, `lunora-action`, `lunora-table`, `lunora-cron` (always use
  the `--name=value` form).

## Checklist

- [ ] Determined starting point: new project or existing app.
- [ ] New project: scaffolded with `lunora init --vite <framework>` (SPA) or
      `lunora init -t <template>` (bespoke) — never `--template vite`.
- [ ] Existing app: ran `lunora init --here` and wired `LunoraProvider`.
- [ ] Ran `lunora codegen`: `lunora/_generated/` exists and typecheck is clean.
- [ ] Dev server is running — user terminal, or `lunora dev --background`
      (check with `lunora dev status`).
- [ ] Verified a query/mutation round-trip re-renders the client live.
